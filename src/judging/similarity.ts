/**
 * Pure TypeScript TF-IDF tokenizer and cosine similarity vector engine.
 *
 * Designed for rival project discovery, thematic content overlap analysis, and
 * side-by-side comparative judging without any external NLP dependencies.
 *
 * Follows repository invariants:
 *   - Pure mathematical implementation (0 dependencies).
 *   - No Math.random() or non-deterministic APIs.
 *   - Strict deterministic token normalization and vector weighting.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
  "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
  "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
  "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
  "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's",
  "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
  "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
  "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or",
  "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same",
  "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so",
  "some", "such", "than", "that", "that's", "the", "their", "theirs", "them",
  "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll",
  "they're", "they've", "this", "those", "through", "to", "too", "under", "until",
  "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
  "weren't", "what", "what's", "when", "when's", "where", "where's", "which",
  "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would",
  "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
  "yourself", "yourselves", "project", "build", "using", "built", "app", "hackathon",
]);

/**
 * Tokenizes arbitrary input text into normalized lowercase word terms.
 * Strips punctuation and excludes common stop words and single-character tokens.
 */
export function tokenizeText(text: string): readonly string[] {
  if (!text || text.trim() === "") return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return words;
}

/**
 * Represents a document in the vector space with computed TF-IDF weights.
 */
export type DocumentVector = {
  readonly id: string;
  readonly terms: ReadonlyMap<string, number>;
  readonly norm: number;
};

/**
 * Vectorizes a corpus of documents using TF-IDF weighting.
 */
export function vectorizeCorpus(
  documents: readonly { readonly id: string; readonly text: string }[],
): ReadonlyMap<string, DocumentVector> {
  const n = documents.length;
  if (n === 0) return new Map();

  const tokenized = documents.map((doc) => ({
    id: doc.id,
    tokens: tokenizeText(doc.text),
  }));

  // Document frequency: count of documents containing each term
  const docFreq = new Map<string, number>();
  for (const doc of tokenized) {
    const uniqueTerms = new Set(doc.tokens);
    for (const term of uniqueTerms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  // Compute IDF for each term: ln(1 + (N / (1 + df))) + 1
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq.entries()) {
    idf.set(term, Math.log(1 + n / (1 + df)) + 1);
  }

  const result = new Map<string, DocumentVector>();

  for (const doc of tokenized) {
    if (doc.tokens.length === 0) {
      result.set(doc.id, { id: doc.id, terms: new Map(), norm: 0 });
      continue;
    }

    // Term frequency in this document
    const termCount = new Map<string, number>();
    for (const term of doc.tokens) {
      termCount.set(term, (termCount.get(term) ?? 0) + 1);
    }

    const docLen = doc.tokens.length;
    const weights = new Map<string, number>();
    let sumSq = 0;

    for (const [term, count] of termCount.entries()) {
      const tf = count / docLen;
      const termIdf = idf.get(term) ?? 1;
      const tfidf = tf * termIdf;
      weights.set(term, tfidf);
      sumSq += tfidf * tfidf;
    }

    result.set(doc.id, {
      id: doc.id,
      terms: weights,
      norm: Math.sqrt(sumSq),
    });
  }

  return result;
}

/**
 * Computes cosine similarity between two DocumentVectors.
 * Returns a value between 0.0 (completely orthogonal) and 1.0 (identical vectors).
 */
export function cosineSimilarity(
  docA: DocumentVector,
  docB: DocumentVector,
): number {
  if (docA.norm === 0 || docB.norm === 0) return 0;

  // Dot product over shared terms
  let dot = 0;
  const [smaller, larger] =
    docA.terms.size <= docB.terms.size
      ? [docA.terms, docB.terms]
      : [docB.terms, docA.terms];

  for (const [term, weightA] of smaller.entries()) {
    const weightB = larger.get(term);
    if (weightB !== undefined) {
      dot += weightA * weightB;
    }
  }

  const sim = dot / (docA.norm * docB.norm);
  return Math.max(0, Math.min(1, Math.round(sim * 10000) / 10000));
}

/**
 * Finds common high-weight keywords between two DocumentVectors.
 */
export function extractSharedKeywords(
  docA: DocumentVector,
  docB: DocumentVector,
  maxKeywords: number = 6,
): readonly string[] {
  const shared: { term: string; score: number }[] = [];
  for (const [term, weightA] of docA.terms.entries()) {
    const weightB = docB.terms.get(term);
    if (weightB !== undefined) {
      shared.push({ term, score: weightA * weightB });
    }
  }
  shared.sort((a, b) => b.score - a.score);
  return shared.slice(0, maxKeywords).map((s) => s.term);
}

/**
 * Convenience function to compare two texts directly within an optional background corpus.
 */
export function compareTexts(
  textA: string,
  textB: string,
  corpusTexts: readonly string[] = [],
): {
  readonly similarity: number;
  readonly sharedKeywords: readonly string[];
} {
  const docs = [
    { id: "A", text: textA },
    { id: "B", text: textB },
    ...corpusTexts.map((text, i) => ({ id: `corpus_${i}`, text })),
  ];
  const vectors = vectorizeCorpus(docs);
  const vecA = vectors.get("A")!;
  const vecB = vectors.get("B")!;
  const similarity = cosineSimilarity(vecA, vecB);
  const sharedKeywords = extractSharedKeywords(vecA, vecB);
  return { similarity, sharedKeywords };
}

/**
 * Discovers the top rival projects for a target project from a candidate pool.
 */
export function findRivals(
  targetId: string,
  projects: readonly { readonly id: string; readonly text: string }[],
  limit: number = 5,
): readonly {
  readonly rivalId: string;
  readonly similarity: number;
  readonly sharedKeywords: readonly string[];
}[] {
  const vectors = vectorizeCorpus(projects);
  const targetVec = vectors.get(targetId);
  if (!targetVec) return [];

  const rivals: {
    rivalId: string;
    similarity: number;
    sharedKeywords: readonly string[];
  }[] = [];

  for (const [id, vec] of vectors.entries()) {
    if (id === targetId) continue;
    const similarity = cosineSimilarity(targetVec, vec);
    if (similarity > 0.01) {
      rivals.push({
        rivalId: id,
        similarity,
        sharedKeywords: extractSharedKeywords(targetVec, vec),
      });
    }
  }

  rivals.sort((a, b) => b.similarity - a.similarity);
  return rivals.slice(0, limit);
}
