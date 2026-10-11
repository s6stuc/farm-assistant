import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const targetWords = 350;
const overlapWords = 50;

interface FrontMatter {
  title?: string;
  date?: string;
  categories?: string[];
}

interface Chunk {
  id: string;
  source: string;
  title: string;
  date?: string;
  categories: string[];
  section: string;
  images: ImageReference[];
  text: string;
  wordCount: number;
}

interface ImageReference {
  type: 'image' | 'video';
  path: string;
  description: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = resolve(scriptDirectory, '../../..');
const projectDirectory =
  basename(process.cwd()) === 'api' ? dirname(process.cwd()) : apiDirectory;
const markdownDirectory = join(projectDirectory, 'md');
const outputDirectory = join(projectDirectory, 'chunks');
const outputFile = join(outputDirectory, 'chunks.jsonl');

const stripQuotes = (value: string): string =>
  value.replace(/^['"]|['"]$/g, '').trim();

const parseCategories = (value: string): string[] => {
  const normalized = value.replace(/^\[|\]$/g, '');
  return normalized
    .split(',')
    .map((category) => stripQuotes(category))
    .filter(Boolean);
};

const parseFrontMatter = (
  content: string,
): { frontMatter: FrontMatter; body: string } => {
  const lines = content.split(/\r?\n/);
  const opening = /^(---|yarn ---)$/.test(lines[0]?.trim() ?? '');

  if (!opening) {
    return { frontMatter: {}, body: content };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (closingIndex === -1) {
    return { frontMatter: {}, body: content };
  }

  const frontMatter: FrontMatter = {};
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^(title|date|categories):\s*(.*)$/.exec(line.trim());
    if (!match) continue;

    const [, key, value] = match;
    if (key === 'title') frontMatter.title = stripQuotes(value);
    if (key === 'date') frontMatter.date = stripQuotes(value);
    if (key === 'categories') frontMatter.categories = parseCategories(value);
  }

  return { frontMatter, body: lines.slice(closingIndex + 1).join('\n') };
};

const cleanMarkdown = (content: string): string => {
  const withCaptions = content.replace(
    /\{%\s*include\s+(image|video)\.html\b([^%]*?)%\}/gi,
    (_match, type: string, attributes: string) => {
      const path = /\bsrc="([^"]+)"/i.exec(attributes)?.[1];
      const caption = /\bcaption="([^"]*)"/i.exec(attributes)?.[1]?.trim();
      if (!path) return '\n';
      return `\n[${type.toLowerCase() === 'video' ? 'Video' : 'Image'}: ${path}]${caption ? `\n[Image caption: ${caption}]` : ''}\n`;
    },
  );

  return withCaptions
    .replace(/\{%[^%]*%\}/g, '')
    .replace(/^\s*\{%[^\n]*$/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*---\s*$/gm, '')
    .replace(/^#{1,6}\s*(.*?)\s*#*\s*$/gm, '# $1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const wordCount = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

const extractImages = (text: string): ImageReference[] => {
  const images: ImageReference[] = [];
  const pattern =
    /\[(Image|Video): ([^\]]+)\](?:\s*\[Image caption: ([^\]]*)\])?/g;
  for (const match of text.matchAll(pattern)) {
    images.push({
      type: match[1].toLowerCase() === 'video' ? 'video' : 'image',
      path: match[2],
      description: match[3]?.trim() ?? '',
    });
  }
  return images;
};

const splitLongSection = (section: string): string[] => {
  const paragraphs = section
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n\n'));
    current = [];
  };

  for (const paragraph of paragraphs) {
    const paragraphWords = wordCount(paragraph);
    if (paragraphWords > targetWords) {
      flush();
      const words = paragraph.split(/\s+/).filter(Boolean);
      for (
        let index = 0;
        index < words.length;
        index += targetWords - overlapWords
      ) {
        chunks.push(words.slice(index, index + targetWords).join(' '));
      }
      continue;
    }

    const candidate = [...current, paragraph].join('\n\n');
    if (current.length > 0 && wordCount(candidate) > targetWords) {
      const previousWords = current.join(' ').split(/\s+/).filter(Boolean);
      flush();
      current = [previousWords.slice(-overlapWords).join(' '), paragraph];
      continue;
    }

    current.push(paragraph);
  }

  flush();
  return chunks;
};

const sectionize = (
  content: string,
  fallbackTitle: string,
): Array<{ section: string; text: string }> => {
  const sections: Array<{ section: string; text: string }> = [];
  let section = fallbackTitle;
  let lines: string[] = [];

  const flush = (): void => {
    const text = lines.join('\n').trim();
    if (text) sections.push({ section, text });
    lines = [];
  };

  for (const line of content.split('\n')) {
    const heading = /^#\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      section = heading[1].trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
};

const listMarkdownFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(path)));
    else if (entry.isFile() && extname(entry.name) === '.md') files.push(path);
  }

  return files.sort();
};

const loadChunks = async (): Promise<Chunk[]> => {
  const chunks: Chunk[] = [];
  const files = await listMarkdownFiles(markdownDirectory);

  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const { frontMatter, body } = parseFrontMatter(raw);
    const cleaned = cleanMarkdown(body);
    const title = frontMatter.title ?? basename(file, '.md');
    const source = relative(projectDirectory, file);
    let fileChunkIndex = 0;

    for (const section of sectionize(cleaned, title)) {
      for (const text of splitLongSection(section.text)) {
        const images = extractImages(text);
        const textWithoutImageMarkers = text
          .replace(/\[(?:Image|Video): [^\]]+\]\s*/g, '')
          .trim();
        chunks.push({
          id: `${source.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${fileChunkIndex++}`,
          source,
          title,
          ...(frontMatter.date ? { date: frontMatter.date } : {}),
          categories: frontMatter.categories ?? [],
          section: section.section,
          images,
          text:
            section.section === title
              ? `${title}\n\n${textWithoutImageMarkers}`
              : `${title}\n\n${section.section}\n\n${textWithoutImageMarkers}`,
          wordCount: wordCount(textWithoutImageMarkers),
        });
      }
    }
  }

  return chunks;
};

const chunks = await loadChunks();
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  outputFile,
  `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`,
  'utf8',
);

console.log(
  `Wrote ${chunks.length} chunks from ${new Set(chunks.map((chunk) => chunk.source)).size} Markdown files to ${relative(projectDirectory, outputFile)}`,
);
