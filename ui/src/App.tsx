import { FormEvent, type ReactElement, useState } from 'react';

interface Source {
  id: string;
  source: string;
  title: string;
  section: string;
  images: ImageReference[];
}

interface ImageReference {
  type: 'image' | 'video';
  path: string;
  description: string;
}

interface AskResponse {
  answer: string[];
  sources: Source[];
}

const apiUrl = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export function App(): ReactElement {
  const [question, setQuestion] = useState('');
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const askQuestion = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || loading) return;

    setLoading(true);
    setError('');
    setResponse(null);

    try {
      const result = await fetch(`${apiUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmedQuestion }),
      });

      const body = (await result.json()) as AskResponse | { error?: string };
      if (!result.ok || !('answer' in body)) {
        throw new Error('error' in body ? body.error : 'The request failed');
      }

      setResponse(body);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'The request failed',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="app">
      <h1>Farm assistant</h1>
      <p>Ask a question about Loxley Valley Community Farm.</p>

      <form className="question-form" onSubmit={askQuestion}>
        <label htmlFor="question">Question</label>
        <input
          type="text"
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What does a feed involve?"
        />
        <button type="submit" disabled={loading || !question.trim()}>
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {response && (
        <section className="answer" aria-live="polite">
          <h2>Answer</h2>
          {response.answer.map((paragraph, index) => (
            <p key={`${index}-${paragraph}`}>{paragraph}</p>
          ))}
          {response.sources.some((source) =>
            source.images.some((image) => image.type === 'image'),
          ) && (
            <div className="image-results">
              <h3>Related images</h3>
              <div className="image-grid">
                {response.sources.flatMap((source) =>
                  source.images
                    .filter((image) => image.type === 'image')
                    .map((image) => (
                      <figure key={`${source.id}-${image.path}`}>
                        <img
                          src={`/images/${image.path}`}
                          alt={image.description || image.path}
                          onError={(event) => {
                            event.currentTarget.closest('figure')?.remove();
                          }}
                        />
                        <figcaption>
                          {image.description || image.path}
                        </figcaption>
                      </figure>
                    )),
                )}
              </div>
            </div>
          )}
          {response.sources.length > 0 && (
            <div>
              <h3>Sources</h3>
              <ul>
                {response.sources.map((source) => (
                  <li key={source.id}>
                    <div>
                      {source.source} — {source.section}
                    </div>
                    {source.images.length > 0 && (
                      <ul>
                        {source.images.map((image) => (
                          <li key={`${source.id}-${image.path}`}>
                            {image.type}: {image.description || image.path}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
