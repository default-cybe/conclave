/** Error carrying an HTTP status so the server can map it directly. */
export class EngineError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
