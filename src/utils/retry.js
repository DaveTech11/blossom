export async function withRetry(fn, {
  retries = 3,
  baseDelayMs = 1000,
  maxDelayMs = 15000,
  shouldRetry = () => true,
  onRetry = () => {}
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      await onRetry(error, attempt, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
