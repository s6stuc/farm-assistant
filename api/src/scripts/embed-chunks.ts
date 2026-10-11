import { readFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';
import { Ollama } from 'ollama';

interface Chunk {
  id: string;
  source: string;
  title: string;
  date?: string;
  categories: string[];
  section: string;
  images: Array<{
    type: 'image' | 'video';
    path: string;
    description: string;
  }>;
  text: string;
  wordCount: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = resolve(scriptDirectory, '../../..');
const projectDirectory =
  basename(process.cwd()) === 'api' ? dirname(process.cwd()) : apiDirectory;
const chunksFile = join(projectDirectory, 'chunks', 'chunks.jsonl');
const databaseDirectory = join(projectDirectory, 'data', 'lancedb');
const tableName = process.env.LANCEDB_TABLE ?? 'document_chunks';
const ollamaHost = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const embeddingModel = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
const batchSize = Number(process.env.OLLAMA_EMBED_BATCH_SIZE ?? 8);

const readChunks = async (): Promise<Chunk[]> => {
  const content = await readFile(chunksFile, 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Chunk;
      } catch (error) {
        console.error(error);
        throw new Error(`Invalid JSON on line ${index + 1} of ${chunksFile}`);
      }
    });
};

const embedChunks = async (
  ollama: Ollama,
  chunks: Chunk[],
): Promise<number[][]> => {
  const embeddings: number[][] = [];

  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const response = await ollama.embed({
      model: embeddingModel,
      input: batch.map((chunk) => chunk.text),
    });

    if (response.embeddings.length !== batch.length) {
      throw new Error(
        `Ollama returned ${response.embeddings.length} embeddings for ${batch.length} chunks`,
      );
    }

    embeddings.push(...response.embeddings);
    console.log(
      `Embedded ${Math.min(start + batch.length, chunks.length)} / ${chunks.length} chunks`,
    );
  }

  return embeddings;
};

const main = async (): Promise<void> => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('OLLAMA_EMBED_BATCH_SIZE must be a positive integer');
  }

  const chunks = await readChunks();
  if (chunks.length === 0) throw new Error(`No chunks found in ${chunksFile}`);

  await mkdir(databaseDirectory, { recursive: true });
  const ollama = new Ollama({ host: ollamaHost });
  const embeddings = await embedChunks(ollama, chunks);
  const db = await lancedb.connect(databaseDirectory);
  const records = chunks.map((chunk, index) => ({
    id: chunk.id,
    source: chunk.source,
    title: chunk.title,
    date: chunk.date ?? '',
    categories: chunk.categories.join(', '),
    section: chunk.section,
    images: JSON.stringify(chunk.images),
    text: chunk.text,
    wordCount: chunk.wordCount,
    embeddingModel,
    vector: embeddings[index],
  }));

  await db.createTable(tableName, records, { mode: 'overwrite' });
  console.log(
    `Wrote ${records.length} embedded chunks to ${databaseDirectory}/${tableName}`,
  );
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
