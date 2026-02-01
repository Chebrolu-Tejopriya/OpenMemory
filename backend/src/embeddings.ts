import OpenAI from 'openai';

const openai = new OpenAI();

/**
 * Generates embeddings for an array of texts using OpenAI's API.
 * Uses text-embedding-3-small for cost efficiency.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });

  // Sort by index to maintain order
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(item => item.embedding);
}

