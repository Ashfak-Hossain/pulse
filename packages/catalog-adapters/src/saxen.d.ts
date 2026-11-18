// saxen ships no types. Only what fitsGrid() calls
declare module 'saxen' {
  export class Parser {
    on(
      event: 'openTag',
      callback: (
        name: string,
        getAttributes: () => Record<string, string>,
        decodeEntities: (value: string) => string,
      ) => void,
    ): void;
    on(event: 'closeTag', callback: (name: string) => void): void;
    parse(xml: string): Error | null;
    stop(): void;
  }
}
