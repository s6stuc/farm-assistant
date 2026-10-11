import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';
import { Ollama } from 'ollama';

interface RetrievedChunk {
  id: string;
  source: string;
  title: string;
  section: string;
  images: string;
  text: string;
  _distance?: number;
}

interface ImageReference {
  type: 'image' | 'video';
  path: string;
  description: string;
}

interface RagAnswer {
  answer: string[];
  sources: Array<
    Pick<RetrievedChunk, 'id' | 'source' | 'title' | 'section'> & {
      images: ImageReference[];
    }
  >;
}

const parseImages = (value: string): ImageReference[] => {
  try {
    return JSON.parse(value) as ImageReference[];
  } catch {
    return [];
  }
};

const splitParagraphs = (answer: string): string[] =>
  answer
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const projectDirectory =
  basename(process.cwd()) === 'api'
    ? dirname(process.cwd())
    : dirname(apiDirectory);
const databaseDirectory = join(projectDirectory, 'data', 'lancedb');
const tableName = process.env.LANCEDB_TABLE ?? 'document_chunks';
const ollamaHost = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const embeddingModel = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
const chatModel = process.env.OLLAMA_CHAT_MODEL ?? 'llama3.2:3b';
const defaultResultLimit = 5;

const systemPrompt = `You answer questions using only the supplied context about Loxley Valley Community Farm.

Rules:
- If the context does not clearly answer the question, say exactly: "I'm not clear on that from the available information."
- Do not guess, infer unsupported facts, or use general knowledge.
- Keep answers concise and useful.
- When answering, cite supporting source filenames in square brackets, for example [md/membership.md].
- If the context contains conflicting or outdated information, say so clearly.`;

const answerQuestion = async (
  question: string,
  limit: number,
): Promise<RagAnswer> => {
  const ollama = new Ollama({ host: ollamaHost });
  const embeddingResponse = await ollama.embed({
    model: embeddingModel,
    input: question,
  });
  const db = await lancedb.connect(databaseDirectory);
  const table = await db.openTable(tableName);
  const results = (await table
    .search(embeddingResponse.embeddings[0])
    .limit(limit)
    .toArray()) as RetrievedChunk[];

  if (results.length === 0) {
    return {
      answer: ["I'm not clear on that from the available information."],
      sources: [],
    };
  }

  const context = results
    .map(
      (result, index) =>
        `Source ${index + 1}: ${result.source}\n${result.text}\n${parseImages(
          result.images,
        )
          .map(
            (image) =>
              `Related ${image.type}: ${image.path} — ${image.description}`,
          )
          .join('\n')}`,
    )
    .join('\n\n---\n\n');
  const response = await ollama.chat({
    model: chatModel,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Context:\n\n${context}\n\nQuestion: ${question}`,
      },
    ],
    options: { temperature: 0 },
  });

  return {
    answer: splitParagraphs(response.message.content),
    sources: results.map(({ id, source, title, section, images }) => ({
      id,
      source,
      title,
      section,
      images: parseImages(images),
    })),
  };
};

export const ask = async (
  question: string,
  requestedLimit?: number,
): Promise<RagAnswer> => {
  const limit = requestedLimit ?? defaultResultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('limit must be an integer between 1 and 10');
  }

  return answerQuestion(question, limit);
};
