/**
 * Supabase Edge Function: Generate Embedding
 *
 * Uses HuggingFace Inference API with BGE-small-en-v1.5 model
 * (Same model as local FastEmbed for consistency)
 *
 * Supports both text and image embeddings:
 * - Text: BAAI/bge-small-en-v1.5 (384 dim)
 * - Image: openai/clip-vit-base-patch32 (512 dim)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Model endpoints
const TEXT_MODEL_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/BAAI/bge-small-en-v1.5'
const IMAGE_MODEL_URL = 'https://api-inference.huggingface.co/models/openai/clip-vit-base-patch32'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { text, image_url, type = 'text', table, record, id } = body

    const hfToken = Deno.env.get('HUGGINGFACE_API_KEY') || ''

    // Handle database webhook (auto-embedding on insert)
    if (table && (record || id)) {
      return await handleDatabaseWebhook(body, hfToken)
    }

    if (type === 'image' && image_url) {
      // Generate image embedding using CLIP
      return await generateImageEmbedding(image_url, hfToken)
    } else if (text && typeof text === 'string') {
      // Generate text embedding using BGE
      return await generateTextEmbedding(text, hfToken)
    } else {
      return new Response(
        JSON.stringify({ error: 'text or image_url parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// Handle database webhook for auto-embedding
async function handleDatabaseWebhook(body: any, hfToken: string) {
  const { table, record, type: eventType } = body

  // Only process inserts and updates
  if (eventType && !['INSERT', 'UPDATE'].includes(eventType)) {
    return new Response(
      JSON.stringify({ message: 'Skipped - not an INSERT or UPDATE' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Skip if embedding already exists
  if (record?.embedding) {
    return new Response(
      JSON.stringify({ message: 'Skipped - embedding already exists' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Build text content based on table
  let textContent = ''
  if (table === 'bookmarks') {
    textContent = [record?.title, record?.folder, record?.url].filter(Boolean).join(' ')
  } else if (table === 'pinterest_pins') {
    textContent = [record?.title, record?.description, record?.board_name].filter(Boolean).join(' ')
  } else {
    return new Response(
      JSON.stringify({ error: 'Unknown table' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (!textContent.trim()) {
    return new Response(
      JSON.stringify({ message: 'Skipped - no text content' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Generate embedding
  const embeddingResponse = await generateTextEmbeddingRaw(textContent, hfToken)
  if (!embeddingResponse) {
    return new Response(
      JSON.stringify({ error: 'Failed to generate embedding' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Update the row with the embedding
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseKey)

  const { error } = await supabase
    .from(table)
    .update({ embedding: embeddingResponse })
    .eq('id', record.id)

  if (error) {
    console.error('Update error:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to update embedding', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({ success: true, table, id: record.id, dimension: embeddingResponse.length }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// Generate embedding and return raw array (for internal use)
async function generateTextEmbeddingRaw(text: string, hfToken: string): Promise<number[] | null> {
  try {
    const prefixedText = `passage: ${text.substring(0, 512)}`

    const response = await fetch(TEXT_MODEL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: prefixedText,
        options: { wait_for_model: true }
      })
    })

    if (!response.ok) {
      console.error('HF API error:', response.status)
      return null
    }

    const embedding = await response.json()
    return normalizeEmbedding(embedding)
  } catch (error) {
    console.error('Embedding error:', error)
    return null
  }
}

async function generateTextEmbedding(text: string, hfToken: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)

  try {
    // Add BGE query prefix for better retrieval
    const prefixedText = `passage: ${text.substring(0, 512)}`

    const response = await fetch(TEXT_MODEL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: prefixedText,
        options: { wait_for_model: true }
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const error = await response.text()
      console.error('HF API error:', response.status, error)

      return new Response(
        JSON.stringify({ embedding: null, fallback: true, error: 'Model unavailable' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const embedding = await response.json()

    // Normalize the embedding
    const normalized = normalizeEmbedding(embedding)

    return new Response(
      JSON.stringify({
        embedding: normalized,
        dimension: normalized?.length || 0,
        model: 'bge-small-en-v1.5'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (fetchError) {
    clearTimeout(timeout)
    console.error('Fetch error:', fetchError.message)

    return new Response(
      JSON.stringify({ embedding: null, fallback: true, error: fetchError.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}

async function generateImageEmbedding(imageUrl: string, hfToken: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  try {
    // Fetch the image
    const imageResponse = await fetch(imageUrl, { signal: controller.signal })
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.status}`)
    }

    const imageBlob = await imageResponse.blob()

    // Send to CLIP model
    const response = await fetch(IMAGE_MODEL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfToken}`,
      },
      body: imageBlob,
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const error = await response.text()
      console.error('HF CLIP API error:', response.status, error)

      return new Response(
        JSON.stringify({ embedding: null, fallback: true, error: 'Image model unavailable' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const result = await response.json()

    // CLIP returns embeddings in a specific format
    const embedding = extractClipEmbedding(result)
    const normalized = normalizeEmbedding(embedding)

    return new Response(
      JSON.stringify({
        embedding: normalized,
        dimension: normalized?.length || 0,
        model: 'clip-vit-base-patch32'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (fetchError) {
    clearTimeout(timeout)
    console.error('Image embedding error:', fetchError.message)

    return new Response(
      JSON.stringify({ embedding: null, fallback: true, error: fetchError.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}

function extractClipEmbedding(result: any): number[] | null {
  // Handle different response formats from HF API
  if (Array.isArray(result)) {
    // Direct array of numbers
    if (typeof result[0] === 'number') {
      return result
    }
    // Nested array
    if (Array.isArray(result[0])) {
      return result[0]
    }
  }
  // Object with embedding field
  if (result?.embedding) {
    return result.embedding
  }
  return null
}

function normalizeEmbedding(embedding: any): number[] | null {
  if (!Array.isArray(embedding)) {
    return null
  }

  // Calculate L2 norm
  const norm = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0))

  if (norm === 0) {
    return embedding
  }

  // Normalize to unit vector
  return embedding.map((val: number) => val / norm)
}
