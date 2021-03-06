import { JsonTokenizerError } from "./error";
import { Token, TokenType } from "./token";

// based on https://www.json.org/json-en.html

export interface TokenizeOptions {
    bufferSize?: number;
}
export const defaultTokenizeOptions = {
    bufferSize: 1024,
};

export async function* tokenize(
    chunks: AsyncIterable<string> | Iterable<string>,
    options: TokenizeOptions = {},
): AsyncIterable<Token> {
    const {
        bufferSize,
    } = {
        ...defaultTokenizeOptions,
        ...options,
    };

    const chars = readChars(chunks);
    const char = chars[Symbol.asyncIterator]();

    let current = await char.next();
    yield* emitRoot();

    async function* emitRoot(): AsyncIterable<Token> {
        yield* emitWhitespace();
        while (!current.done) {
            yield* emitValue();
            yield* emitWhitespace();
        }
    }

    async function* emitValue(): AsyncIterable<Token> {
        assertDone(current);

        switch (current.value) {
            case "{":
                yield* emitObject();
                break;

            case "[":
                yield* emitArray();
                break;

            case "\"":
                yield* emitString();
                break;

            case "-":
                yield* emitNumber();
                break;

            default:
                if (isNumeric(current.value)) {
                    yield* emitNumber();
                    break;
                }
                if (isLowerAlpha(current.value)) {
                    yield* emitKeyword();
                    break;
                }

                throwUnexpected(current.value);
        }
    }

    async function* emitObject(): AsyncIterable<Token> {
        assertDone(current);
        assertExpected(current.value, "{");

        yield {
            type: TokenType.ObjectOpen,
            value: current.value,
        };
        current = await char.next();
        assertDone(current);

        let expectComma = false;
        yield* emitWhitespace();
        while (current.value !== "}") {
            if (expectComma) {
                yield* emitComma();
                yield* emitWhitespace();
            }
            else {
                yield* emitString();
                yield* emitWhitespace();
                yield* emitColon();
                yield* emitWhitespace();
                yield* emitValue();
                yield* emitWhitespace();
            }
            expectComma = !expectComma;
        }

        yield {
            type: TokenType.ObjectClose,
            value: current.value,
        };
        current = await char.next();
    }

    async function* emitArray(): AsyncIterable<Token> {
        assertDone(current);
        assertExpected(current.value, "[");

        yield {
            type: TokenType.ArrayOpen,
            value: current.value,
        };
        current = await char.next();
        assertDone(current);

        let expectComma = false;
        yield* emitWhitespace();
        while (current.value !== "]") {
            if (expectComma) {
                yield* emitComma();
                yield* emitWhitespace();
            }
            else {
                yield* emitValue();
                yield* emitWhitespace();
            }
            expectComma = !expectComma;
        }

        yield {
            type: TokenType.ArrayClose,
            value: current.value,
        };
        current = await char.next();
    }

    async function* emitString(): AsyncIterable<Token> {
        assertDone(current);
        assertExpected(current.value, "\"");

        yield {
            type: TokenType.StringOpen,
            value: current.value,
        };

        current = await char.next();
        assertDone(current);

        let buffer = "";
        while (current.value !== "\"") {

            if (current.value === "\\") {
                buffer += current.value;

                if (buffer.length >= bufferSize) {
                    yield {
                        type: TokenType.StringChunk,
                        value: buffer,
                    };
                    buffer = "";
                }

                current = await char.next();
                assertDone(current);
            }

            buffer += current.value;

            if (buffer.length >= bufferSize) {
                yield {
                    type: TokenType.StringChunk,
                    value: buffer,
                };
                buffer = "";
            }

            current = await char.next();
            assertDone(current);
        }

        if (buffer.length > 0) {
            yield {
                type: TokenType.StringChunk,
                value: buffer,
            };
        }

        yield {
            type: TokenType.StringClose,
            value: current.value,
        };

        current = await char.next();
    }

    // eslint-disable-next-line complexity
    async function* emitNumber(): AsyncIterable<Token> {
        assertDone(current);
        if (!(current.value === "-" || isNumeric(current.value))) {
            throwUnexpected(current.value);
        }

        let buffer = "";

        // minus
        if (current.value === "-") {
            buffer += current.value;
            current = await char.next();
            assertDone(current);
        }

        // integer
        if (current.value === "0") {
            buffer += current.value;

            current = await char.next();
        }
        else if (isNumeric(current.value)) {
            buffer += current.value;
            current = await char.next();

            while (!current.done && isNumeric(current.value)) {
                buffer += current.value;
                current = await char.next();
            }
        }
        else {
            throwUnexpected(current.value);
        }

        // fraction
        if (!current.done && current.value === ".") {
            buffer += current.value;

            current = await char.next();
            assertDone(current);

            if (isNumeric(current.value)) {
                buffer += current.value;
                current = await char.next();

                while (!current.done && isNumeric(current.value)) {
                    buffer += current.value;
                    current = await char.next();
                }
            }
            else {
                throwUnexpected(current.value);
            }
        }

        // exponent
        if (!current.done && current.value === "e" || current.value === "E") {
            buffer += current.value;

            current = await char.next();
            assertDone(current);

            if (current.value === "-" || current.value === "+") {
                buffer += current.value;
                current = await char.next();
                assertDone(current);
            }

            if (isNumeric(current.value)) {
                buffer += current.value;
                current = await char.next();

                while (!current.done && isNumeric(current.value)) {
                    buffer += current.value;
                    current = await char.next();
                }
            }
            else {
                throwUnexpected(current.value);
            }
        }

        yield {
            type: TokenType.Number,
            value: buffer,
        };

    }

    async function* emitKeyword(): AsyncIterable<Token> {
        let buffer = "";

        while (!current.done && isLowerAlpha(current.value)) {
            buffer += current.value;
            current = await char.next();
        }

        switch (buffer) {
            case "true":
                yield {
                    type: TokenType.True,
                    value: buffer,
                };
                break;

            case "false":
                yield {
                    type: TokenType.False,
                    value: buffer,
                };
                break;

            case "null":
                yield {
                    type: TokenType.Null,
                    value: buffer,
                };
                break;

            default: throwUnexpected(buffer);
        }
    }

    async function* emitWhitespace(): AsyncIterable<Token> {
        let buffer = "";

        while (!current.done && isWhitespace(current.value)) {
            buffer += current.value;
            current = await char.next();
        }

        if (buffer.length > 0) yield {
            type: TokenType.Whitespace,
            value: buffer,
        };
    }

    async function* emitComma(): AsyncIterable<Token> {
        assertDone(current);
        assertExpected(current.value, ",");

        yield {
            type: TokenType.Comma,
            value: current.value,
        };

        current = await char.next();
    }

    async function* emitColon(): AsyncIterable<Token> {
        assertDone(current);
        assertExpected(current.value, ":");

        yield {
            type: TokenType.Colon,
            value: current.value,
        };

        current = await char.next();
    }

}

export async function* readChars(chunks: AsyncIterable<string> | Iterable<string>) {
    for await (const chunk of chunks) {
        yield* chunk;
    }
}

export function isLowerAlpha(char: string) {
    return char >= "a" && char <= "z";
}

export function isWhitespace(char: string) {
    return (
        char === "\u0020" || // space
        char === "\u000A" || // line feed
        char === "\u000D" || // carriage return
        char === "\u0009" // horizontal tab
    );
}

function isNumeric(char: string) {
    return char >= "0" && char <= "9";
}

function assertDone(
    result: IteratorResult<string, void>,
): asserts result is IteratorYieldResult<string> {
    assert(result.done ?? false, "Unexpected end of input");
}

function assertExpected(
    actual: string,
    expected: string,
) {
    if (actual !== expected) {
        throwUnexpected(actual);
    }
}

function throwUnexpected(value: string): never {
    throw new JsonTokenizerError(`Unexpected ${value}`);
}

function assert(
    condition: boolean,
    message: string,
): asserts condition {
    if (condition) throw new JsonTokenizerError(message);
}
