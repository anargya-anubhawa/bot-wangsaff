/**
 * GX-ID — /calculator
 *
 * A safe arithmetic evaluator (no eval). Supports + - * / % ^, parentheses and
 * common functions (sqrt, sin, cos, tan, log, ln, abs, round, floor, ceil).
 */
const pluginConfig = {
  name: "calculator",
  alias: ["calc", "hitung", "math"],
  category: "utility",
  description: "Evaluate a math expression",
  usage: ".calculator <expression>",
  example: ".calculator 2 + 2 * (3 ^ 2)",
  isOwner: false,
  isGroup: false,
  cooldown: 3,
  isEnabled: true,
};

const FUNCTIONS = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,
  ln: Math.log,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  exp: Math.exp,
};

const CONSTANTS = { pi: Math.PI, e: Math.E };

/** Tokenize the expression into numbers, identifiers, operators and parens. */
function tokenize(input) {
  const tokens = [];
  const re = /\s*(\d+\.?\d*|\.\d+|[a-zA-Z_][a-zA-Z0-9_]*|[+\-*/%^(),])/g;
  let match;
  let lastIndex = 0;
  while ((match = re.exec(input)) !== null) {
    if (match.index !== lastIndex && input.slice(lastIndex, match.index).trim()) {
      throw new Error("Invalid character in expression");
    }
    tokens.push(match[1]);
    lastIndex = re.lastIndex;
  }
  if (input.slice(lastIndex).trim()) throw new Error("Invalid character in expression");
  return tokens;
}

/** Recursive-descent parser producing a number. */
function parse(tokens) {
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpression() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm() {
    let value = parsePower();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const rhs = parsePower();
      if (op === "*") value *= rhs;
      else if (op === "/") value /= rhs;
      else value %= rhs;
    }
    return value;
  }

  function parsePower() {
    const base = parseUnary();
    if (peek() === "^") {
      next();
      return base ** parsePower();
    }
    return base;
  }

  function parseUnary() {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = next();
    if (token === undefined) throw new Error("Unexpected end of expression");
    if (token === "(") {
      const value = parseExpression();
      if (next() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    if (/^\d/.test(token) || token.startsWith(".")) return parseFloat(token);
    if (/^[a-zA-Z_]/.test(token)) {
      const lower = token.toLowerCase();
      if (lower in CONSTANTS) return CONSTANTS[lower];
      if (lower in FUNCTIONS) {
        if (peek() !== "(") throw new Error(`Function ${token} requires parentheses`);
        next();
        const arg = parseExpression();
        if (next() !== ")") throw new Error("Missing closing parenthesis");
        return FUNCTIONS[lower](arg);
      }
      throw new Error(`Unknown identifier: ${token}`);
    }
    throw new Error(`Unexpected token: ${token}`);
  }

  const result = parseExpression();
  if (pos < tokens.length) throw new Error("Unexpected trailing tokens");
  return result;
}

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  let expr = m.text?.trim();
  if (!expr && m.quoted?.body) expr = m.quoted.body;
  if (!expr) {
    return m.reply(
      `🧮 *Calculator*\n\n> Usage: \`${prefix}calculator <expression>\`\n> Example: \`${prefix}calc 2 + 2 * (3 ^ 2)\``,
    );
  }

  expr = expr.replace(/,/g, "").replace(/x/gi, "*");
  try {
    const result = parse(tokenize(expr));
    if (!Number.isFinite(result)) throw new Error("Result is not a finite number");
    await m.reply(`🧮 *Calculator*\n\n> \`${expr}\`\n> = *${result}*`);
  } catch (error) {
    await m.reply(`❌ *Invalid expression*\n\n> ${error.message}`);
  }
}

export { pluginConfig as config, handler };
