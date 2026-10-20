import ts from "typescript";

/** Parses JSON with comments and trailing commas, the way wrangler reads wrangler.jsonc. */
export function parseJsonc(text: string): any {
  const { config, error } = ts.parseConfigFileTextToJson("wrangler.jsonc", text);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return config;
}
