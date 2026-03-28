/**
 * Supabase Edge Function: Generate Embedding
 * Uses HF Inference API with BGE model (same as local FastEmbed)
 * Falls back gracefully if model is loading
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { text } = await req.json()

    if (!text || typeof text !== 'string') {
      return new Response(
        JSON.stringify({ error: 'text parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const hfToken = Deno.env.get('HUGGINGFACE_API_KEY') || ''

    // Use BGE model via HF Inference - same model as local FastEmbed
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25000) // 25s timeout

    try {
      const response = await fetch(
        'https://api-inference.huggingface.co/pipeline/feature-extraction/BAAI/bge-small-en-v1.5',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            inputs: text.substring(0, 512),
            options: { wait_for_model: true }
          }),
          signal: controller.signal
        }
      )

      clearTimeout(timeout)

      if (!response.ok) {
        const error = await response.text()
        console.error('HF API error:', response.status, error)

        // Return null embedding - search will fall back to text search
        return new Response(
          JSON.stringify({ embedding: null, fallback: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const embedding = await response.json()

      // HF returns the embedding directly as an array
      return new Response(
        JSON.stringify({ embedding: Array.isArray(embedding) ? embedding : null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (fetchError) {
      clearTimeout(timeout)
      console.error('Fetch error:', fetchError.message)

      // Timeout or network error - return null for fallback
      return new Response(
        JSON.stringify({ embedding: null, fallback: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
