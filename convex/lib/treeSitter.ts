/**
 * Tree-sitter WASM parsing engine.
 * Uses web-tree-sitter for parsing source code in Convex actions.
 *
 * Note: In production, WASM grammars are loaded from a CDN or bundled.
 * The web-tree-sitter package works in any JS runtime (including V8 isolates).
 */

import { detectLanguageFromPath, type SupportedLanguage } from "./languageDetector";

export interface ExtractedSymbol {
  name: string;
  type:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "method"
    | "module"
    | "enum"
    | "constant";
  filePath: string;
  language: SupportedLanguage;
  startLine: number;
  endLine: number;
  content: string;
  signature: string | null;
  parentScope: string | null;
  exported: boolean;
  params?: string[];
  returnType?: string;
  extends?: string[];
  implements?: string[];
  children?: ExtractedSymbol[];
}

export interface ImportInfo {
  source: string;
  importedNames: string[];
  isDefault: boolean;
  isNamespace: boolean;
}

export interface FileParseResult {
  filePath: string;
  language: SupportedLanguage;
  symbols: ExtractedSymbol[];
  imports: ImportInfo[];
  exports: string[];
}

// Language-specific AST node types for symbol extraction
const _SYMBOL_NODE_TYPES: Record<string, Record<string, string>> = {
  typescript: {
    function_declaration: "function",
    arrow_function: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "constant",
    variable_declaration: "constant",
  },
  javascript: {
    function_declaration: "function",
    arrow_function: "function",
    method_definition: "method",
    class_declaration: "class",
    variable_declaration: "constant",
  },
  python: {
    function_definition: "function",
    class_definition: "class",
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
    type_declaration: "type",
  },
  rust: {
    function_item: "function",
    impl_item: "class",
    struct_item: "type",
    enum_item: "enum",
    trait_item: "interface",
  },
  java: {
    method_declaration: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
  },
};

/**
 * Extract symbols from source code using regex-based parsing.
 * This is a fallback when tree-sitter WASM is not available.
 * Covers the most common patterns for each language.
 */
export function extractSymbolsRegex(
  content: string,
  filePath: string
): FileParseResult {
  const language = detectLanguageFromPath(filePath);
  const symbols: ExtractedSymbol[] = [];
  const imports: ImportInfo[] = [];
  const exports: string[] = [];
  const lines = content.split("\n");

  if (language === "typescript" || language === "javascript") {
    extractTypeScriptSymbols(content, lines, filePath, language, symbols, imports, exports);
  } else if (language === "python") {
    extractPythonSymbols(content, lines, filePath, language, symbols, imports, exports);
  } else if (language === "go") {
    extractGoSymbols(content, lines, filePath, language, symbols, imports, exports);
  } else if (language === "rust") {
    extractRustSymbols(content, lines, filePath, language, symbols, imports, exports);
  } else if (language === "java") {
    extractJavaSymbols(content, lines, filePath, language, symbols, imports, exports);
  }

  return { filePath, language, symbols, imports, exports };
}

function extractTypeScriptSymbols(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  imports: ImportInfo[],
  exports: string[]
) {
  extractTypeScriptImports(content, imports);
  extractTypeScriptFunctionDeclarations(content, lines, filePath, language, symbols, exports);
  extractTypeScriptArrowFunctions(content, lines, filePath, language, symbols, exports);
  extractTypeScriptClasses(content, lines, filePath, language, symbols, exports);
  extractTypeScriptInterfaces(content, lines, filePath, language, symbols, exports);
  extractTypeScriptTypeAliases(content, lines, filePath, language, symbols, exports);
  extractTypeScriptEnums(content, lines, filePath, language, symbols, exports);
}

function addExport(exports: string[], name: string, isExported: boolean): void {
  if (isExported) exports.push(name);
}

function getStartLine(content: string, matchIndex: number): number {
  return content.slice(0, matchIndex).split("\n").length;
}

function getSymbolContent(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

function extractTypeScriptImports(content: string, imports: ImportInfo[]): void {
  const importRegex =
    /import\s+(?:(?:(\w+)|(\{[^}]+\})|(\*\s+as\s+\w+))\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const defaultName = match[1];
    const namedImports = match[2];
    const namespaceImport = match[3];
    const source = match[4];

    const importedNames: string[] = [];
    if (defaultName) importedNames.push(defaultName);
    if (namedImports) {
      const names = namedImports
        .replace(/[{}]/g, "")
        .split(",")
        .map((n) => n.trim().split(/\s+as\s+/).pop()!.trim())
        .filter(Boolean);
      importedNames.push(...names);
    }
    if (namespaceImport) {
      importedNames.push(namespaceImport.replace(/\*\s+as\s+/, "").trim());
    }

    imports.push({
      source,
      importedNames,
      isDefault: !!defaultName,
      isNamespace: !!namespaceImport,
    });
  }
}

function extractTypeScriptFunctionDeclarations(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  exports: string[],
): void {
  const funcRegex =
    /^(\s*)(export\s+)?((?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?)/gm;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[4];
    const params = match[5];
    const returnType = match[6]?.trim();
    const startLine = getStartLine(content, match.index);
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: "function",
      filePath,
      language,
      startLine,
      endLine,
      content: getSymbolContent(lines, startLine, endLine),
      signature: `${name}(${params})${returnType ? `: ${returnType}` : ""}`,
      parentScope: null,
      exported: isExported,
      params: params
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      returnType: returnType || undefined,
    });
    addExport(exports, name, isExported);
  }
}

function extractTypeScriptArrowFunctions(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  exports: string[],
): void {
  const arrowRegex =
    /^(\s*)(export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*(?::\s*[^\n=>]+)?\s*=>/gm;
  let match: RegExpExecArray | null;
  while ((match = arrowRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const startLine = getStartLine(content, match.index);
    const endLine = findBlockEnd(lines, startLine - 1);
    symbols.push({
      name,
      type: "function",
      filePath,
      language,
      startLine,
      endLine,
      content: getSymbolContent(lines, startLine, endLine),
      signature: name,
      parentScope: null,
      exported: isExported,
    });
    addExport(exports, name, isExported);
  }
}

function extractTypeScriptClasses(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  exports: string[],
): void {
  const classRegex =
    /^(\s*)(export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const extendsName = match[4];
    const implementsNames = match[5]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const startLine = getStartLine(content, match.index);
    const endLine = findBlockEnd(lines, startLine - 1);
    symbols.push({
      name,
      type: "class",
      filePath,
      language,
      startLine,
      endLine,
      content: getSymbolContent(lines, startLine, endLine),
      signature: `class ${name}${extendsName ? ` extends ${extendsName}` : ""}`,
      parentScope: null,
      exported: isExported,
      extends: extendsName ? [extendsName] : undefined,
      implements: implementsNames,
    });
    addExport(exports, name, isExported);
  }
}

function extractTypeScriptInterfaces(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  exports: string[],
): void {
  const ifaceRegex = /^(\s*)(export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const startLine = getStartLine(content, match.index);
    const endLine = findBlockEnd(lines, startLine - 1);
    symbols.push({
      name,
      type: "interface",
      filePath,
      language,
      startLine,
      endLine,
      content: getSymbolContent(lines, startLine, endLine),
      signature: `interface ${name}`,
      parentScope: null,
      exported: isExported,
    });
    addExport(exports, name, isExported);
  }
}

function extractTypeScriptTypeAliases(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  exports: string[],
): void {
  const typeRegex = /^(\s*)(export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/gm;
  let match: RegExpExecArray | null;
  while ((match = typeRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const startLine = getStartLine(content, match.index);
    const endLine = findStatementEnd(lines, startLine - 1);
    symbols.push({
      name,
      type: "type",
      filePath,
      language,
      startLine,
      endLine,
      content: getSymbolContent(lines, startLine, endLine),
      signature: `type ${name}`,
      parentScope: null,
      exported: isExported,
    });
    addExport(exports, name, isExported);
  }
}

function extractTypeScriptEnums(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  exports: string[],
): void {
  const enumRegex = /^(\s*)(export\s+)?enum\s+(\w+)\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = enumRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const startLine = getStartLine(content, match.index);
    const endLine = findBlockEnd(lines, startLine - 1);
    symbols.push({
      name,
      type: "enum",
      filePath,
      language,
      startLine,
      endLine,
      content: getSymbolContent(lines, startLine, endLine),
      signature: `enum ${name}`,
      parentScope: null,
      exported: isExported,
    });
    addExport(exports, name, isExported);
  }
}

function extractPythonSymbols(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  imports: ImportInfo[],
  _exports: string[]
) {
  // Extract imports
  const importRegex = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const source = match[1] || match[2].trim();
    const names = match[2]
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/).pop()!.trim())
      .filter(Boolean);

    imports.push({
      source,
      importedNames: names,
      isDefault: false,
      isNamespace: !match[1],
    });
  }

  // Extract function definitions
  const funcRegex =
    /^([ \t]*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^\n:]+))?\s*:/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const indent = match[1].length;
    const name = match[3];
    const params = match[4];
    const returnType = match[5]?.trim();
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findPythonBlockEnd(lines, startLine - 1, indent);

    symbols.push({
      name,
      type: indent === 0 ? "function" : "method",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `def ${name}(${params})${returnType ? ` -> ${returnType}` : ""}`,
      parentScope: null,
      exported: !name.startsWith("_"),
    });
  }

  // Extract class definitions
  const classRegex = /^class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[1];
    const bases = match[2];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findPythonBlockEnd(lines, startLine - 1, 0);

    symbols.push({
      name,
      type: "class",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `class ${name}${bases ? `(${bases})` : ""}`,
      parentScope: null,
      exported: !name.startsWith("_"),
      extends: bases?.split(",").map((b) => b.trim()).filter(Boolean),
    });
  }
}

function extractGoSymbols(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  imports: ImportInfo[],
  exports: string[]
) {
  // Extract imports
  const singleImportRegex = /^import\s+"([^"]+)"/gm;
  let match;
  while ((match = singleImportRegex.exec(content)) !== null) {
    imports.push({
      source: match[1],
      importedNames: [match[1].split("/").pop()!],
      isDefault: false,
      isNamespace: false,
    });
  }

  // Extract function declarations
  const funcRegex =
    /^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|(\w+))?\s*\{/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const receiver = match[2];
    const name = match[3];
    const params = match[4];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const isExported = name[0] === name[0].toUpperCase();

    symbols.push({
      name,
      type: receiver ? "method" : "function",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `func ${receiver ? `(${receiver}) ` : ""}${name}(${params})`,
      parentScope: receiver || null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }

  // Extract type declarations
  const typeRegex = /^type\s+(\w+)\s+(struct|interface)\s*\{/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[1];
    const kind = match[2] === "interface" ? "interface" : "type";
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const isExported = name[0] === name[0].toUpperCase();

    symbols.push({
      name,
      type: kind as "interface" | "type",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `type ${name} ${match[2]}`,
      parentScope: null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }
}

function extractRustSymbols(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  imports: ImportInfo[],
  exports: string[]
) {
  // Extract use statements
  const useRegex = /^use\s+([^;]+);/gm;
  let match;
  while ((match = useRegex.exec(content)) !== null) {
    imports.push({
      source: match[1],
      importedNames: [match[1].split("::").pop()!],
      isDefault: false,
      isNamespace: false,
    });
  }

  // Extract function items
  const funcRegex =
    /^(\s*)(pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:->\s*([^\n{]+))?\s*\{/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const params = match[4];
    const returnType = match[5]?.trim();
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: "function",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `fn ${name}(${params})${returnType ? ` -> ${returnType}` : ""}`,
      parentScope: null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }

  // Extract struct/enum
  const structRegex = /^(pub\s+)?(struct|enum)\s+(\w+)(?:<[^>]*>)?\s*\{/gm;
  while ((match = structRegex.exec(content)) !== null) {
    const isExported = !!match[1];
    const kind = match[2] === "enum" ? "enum" : "type";
    const name = match[3];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: kind as "enum" | "type",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `${match[2]} ${name}`,
      parentScope: null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }

  // Extract traits
  const traitRegex = /^(pub\s+)?trait\s+(\w+)(?:<[^>]*>)?\s*\{/gm;
  while ((match = traitRegex.exec(content)) !== null) {
    const isExported = !!match[1];
    const name = match[2];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: "interface",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `trait ${name}`,
      parentScope: null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }
}

function extractJavaSymbols(
  content: string,
  lines: string[],
  filePath: string,
  language: SupportedLanguage,
  symbols: ExtractedSymbol[],
  imports: ImportInfo[],
  exports: string[]
) {
  // Extract imports
  const importRegex = /^import\s+(?:static\s+)?([^;]+);/gm;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push({
      source: match[1],
      importedNames: [match[1].split(".").pop()!],
      isDefault: false,
      isNamespace: match[1].endsWith(".*"),
    });
  }

  // Extract class declarations
  const classRegex =
    /^(\s*)(public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: "class",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `class ${name}`,
      parentScope: null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }

  // Extract method declarations
  const methodRegex =
    /^(\s+)(public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[^{]+)?\s*\{/gm;
  while ((match = methodRegex.exec(content)) !== null) {
    const name = match[4];
    const returnType = match[3];
    const params = match[5];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: "method",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `${returnType} ${name}(${params})`,
      parentScope: null,
      exported: match[2] === "public",
    });
  }

  // Extract interfaces
  const ifaceRegex =
    /^(\s*)(public\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/gm;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const isExported = !!match[2];
    const name = match[3];
    const startLine = content.slice(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);

    symbols.push({
      name,
      type: "interface",
      filePath,
      language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      signature: `interface ${name}`,
      parentScope: null,
      exported: isExported,
    });
    if (isExported) exports.push(name);
  }
}

/**
 * Find the end of a brace-delimited block starting at a given line.
 */
function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;

  for (let i = startIdx; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === "{") {
        depth++;
        started = true;
      } else if (char === "}") {
        depth--;
        if (started && depth === 0) {
          return i + 1; // 1-based
        }
      }
    }
  }

  return Math.min(startIdx + 50, lines.length); // Fallback
}

/**
 * Find the end of a statement (semicolon or end of line without continuation).
 */
function findStatementEnd(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.endsWith(";") || (i > startIdx && !line.endsWith("|") && !line.endsWith("&"))) {
      return i + 1;
    }
  }
  return startIdx + 1;
}

/**
 * Find the end of a Python indentation block.
 */
function findPythonBlockEnd(
  lines: string[],
  startIdx: number,
  baseIndent: number
): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // Skip empty lines

    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) {
      return i; // 1-based: this line is already outside the block
    }
  }
  return lines.length;
}

/**
 * Parse a file and extract all symbols.
 * Uses regex-based extraction (tree-sitter WASM can be swapped in later).
 */
export function parseFileAndExtractSymbols(
  content: string,
  filePath: string
): FileParseResult {
  return extractSymbolsRegex(content, filePath);
}
