import type { z } from 'zod';
import { AIValidationError } from '../errors/index.js';
import { extractJsonFromText } from './structured.js';

export interface BaseOutputParser<T> {
  parse(text: string): T | Promise<T>;
}

/**
 * Parses conversational text, extracts JSON block, and parses into JS object.
 */
export class JSONOutputParser implements BaseOutputParser<unknown> {
  parse(text: string): unknown {
    const jsonStr = extractJsonFromText(text);
    if (!jsonStr) {
      throw new Error('No JSON block found in response');
    }
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Extracts standard XML tags from text and formats them into a key-value dictionary.
 */
export class XMLOutputParser implements BaseOutputParser<Record<string, string>> {
  parse(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    const regex = /<(\w+)(?:\s+[^>]*)*>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[1] && match[2]) {
        result[match[1]] = match[2].trim();
      }
    }
    return result;
  }
}

/**
 * Parses bulleted or comma-separated lists into an array of trimmed strings.
 */
export class ListOutputParser implements BaseOutputParser<string[]> {
  parse(text: string): string[] {
    const lines = text.split('\n');
    const result: string[] = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      const bulletMatch = line.match(/^(?:[-*+]\s*|\d+\.\s*)(.*)$/);
      if (bulletMatch?.[1]) {
        result.push(bulletMatch[1].trim());
      } else {
        const parts = line
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        result.push(...parts);
      }
    }
    return result.filter(Boolean);
  }
}

/**
 * Combines JSON output parsing with Zod schema verification and custom errors.
 */
export class StructuredOutputParser<T> implements BaseOutputParser<T> {
  private jsonParser = new JSONOutputParser();

  constructor(public readonly schema: z.ZodType<T>) {}

  static fromZodSchema<S>(schema: z.ZodType<S>): StructuredOutputParser<S> {
    return new StructuredOutputParser(schema);
  }

  parse(text: string): T {
    let parsed: unknown;
    try {
      parsed = this.jsonParser.parse(text);
    } catch (err) {
      throw new AIValidationError(
        'Zod Schema',
        text,
        [err],
        `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = this.schema.safeParse(parsed);
    if (!result.success) {
      throw new AIValidationError(
        'Zod Schema',
        text,
        result.error.issues,
        'Structured output validation failed',
      );
    }

    return result.data;
  }
}
