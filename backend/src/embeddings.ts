/**
 * FastEmbed Embedding Module
 *
 * Uses Qdrant's FastEmbed Python library for both text and image embeddings.
 *
 * Text Model: BAAI/bge-small-en-v1.5 (384 dimensions)
 * Image Model: Qdrant/clip-ViT-B-32-vision (512 dimensions)
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = path.join(__dirname, '..', 'python', 'embed.py');

// Embedding dimensions
export const TEXT_EMBEDDING_DIM = 384;  // BGE-small-en-v1.5
export const IMAGE_EMBEDDING_DIM = 512; // CLIP ViT-B/32

interface EmbeddingResult {
  embedding: number[] | null;
  dimension?: number;
  error?: string;
}

interface BatchEmbeddingResult {
  embeddings: (number[] | null)[];
  count: number;
  error?: string;
}

/**
 * Call Python FastEmbed script
 */
async function callPython(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const python = spawn('python', [PYTHON_SCRIPT, command, input], {
      cwd: path.dirname(PYTHON_SCRIPT),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python process exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });
  });
}

/**
 * Generate text embedding using FastEmbed BGE-small model
 * Returns 384-dimensional vector
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await callPython('text', text);
    const parsed: EmbeddingResult = JSON.parse(result);

    if (parsed.error) {
      console.error('Text embedding error:', parsed.error);
      return null;
    }

    return parsed.embedding;
  } catch (error) {
    console.error('Failed to generate text embedding:', error);
    return null;
  }
}

/**
 * Generate batch text embeddings
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  try {
    const result = await callPython('batch-text', JSON.stringify(texts));
    const parsed: BatchEmbeddingResult = JSON.parse(result);

    if (parsed.error) {
      console.error('Batch text embedding error:', parsed.error);
      return [];
    }

    return parsed.embeddings.filter((e): e is number[] => e !== null);
  } catch (error) {
    console.error('Failed to generate batch text embeddings:', error);
    return [];
  }
}

/**
 * Generate query embedding (optimized for search queries)
 * Uses FastEmbed's query_embed which adds "query:" prefix
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  try {
    const result = await callPython('query', query);
    const parsed: EmbeddingResult = JSON.parse(result);

    if (parsed.error || !parsed.embedding) {
      throw new Error(parsed.error || 'Failed to generate query embedding');
    }

    return parsed.embedding;
  } catch (error) {
    console.error('Failed to generate query embedding:', error);
    throw error;
  }
}

/**
 * Generate image embedding using FastEmbed CLIP model
 * Returns 512-dimensional vector
 *
 * @param imageUrl - URL or local path of the image
 */
export async function generateImageEmbedding(imageUrl: string): Promise<number[] | null> {
  try {
    const result = await callPython('image', imageUrl);
    const parsed: EmbeddingResult = JSON.parse(result);

    if (parsed.error) {
      console.error('Image embedding error:', parsed.error);
      return null;
    }

    return parsed.embedding;
  } catch (error) {
    console.error('Failed to generate image embedding:', error);
    return null;
  }
}

/**
 * Generate batch image embeddings
 * Returns array of 512-dimensional vectors (null for failed images)
 */
export async function generateImageEmbeddings(imageUrls: string[]): Promise<(number[] | null)[]> {
  if (imageUrls.length === 0) return [];

  try {
    const result = await callPython('batch-image', JSON.stringify(imageUrls));
    const parsed: BatchEmbeddingResult = JSON.parse(result);

    if (parsed.error) {
      console.error('Batch image embedding error:', parsed.error);
      return imageUrls.map(() => null);
    }

    return parsed.embeddings;
  } catch (error) {
    console.error('Failed to generate batch image embeddings:', error);
    return imageUrls.map(() => null);
  }
}

/**
 * Check if Python FastEmbed is available
 */
export async function checkFastEmbedAvailable(): Promise<boolean> {
  try {
    await callPython('text', 'test');
    return true;
  } catch {
    return false;
  }
}
