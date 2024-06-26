import ollama, { type ChatRequest } from 'ollama'
import debug from 'debug'
import { Either, left, right } from '@sweet-monads/either'
import { asyncChainLeft } from './async-chain-left.js'
import { stripIndent } from 'common-tags'
import { tryCatch } from './try-catch.js'
import { logLine, logWrite } from './log-debug.js'

export const defaults = {
  model: 'llama3',
  retries: 3
}

const log = debug('app:chat')

type ShouldStopStreaming = (data: {
  fullResponse: string
  responseChunk: string
}) => boolean

export const chat = async <T = string>(options: {
  model?: ChatRequest['model']
  messages: ChatRequest['messages']
  repeatLastN?: number
  repeatPenalty?: number
  temperature?: number
  topK?: number
  topP?: number
  stop?: string[]
  /**
   * Transform the response to the desired type. Left string is interpreted as
   * error text, and the chat will continue with the error text as the next
   * message.
   */
  transform?: (x: any) => Either<string, T>
  retries?: number
  /**
   * If the response should be parsed as JSON. If 'object', Ollama's built-in
   * JSON parsing is used, and the response is expected to be a JSON object.
   * If 'any', the response is parsed as JSON, but it can be any JSON value,
   * i.e. a string, number, object, array, boolean, or null. If false, the
   * response is returned as a string.
   */
  isJson?: false | 'any' | 'object'
  /**
   * The grammar to enforce on the response. This is useful for ensuring that
   * the response is a valid JSON object, for example.
   * @link https://github.com/ggerganov/llama.cpp/blob/master/grammars/README.md
   */
  grammar?: string
  /**
   * If the chat should stop streaming based on the response. This is useful
   * for stopping the chat when the response is a JSON object, for example.
   * Important to specify, since Mistral has a tendency not to stop, even
   * though in theory a fix was made in 1.29.0:
   * https://github.com/ollama/ollama/issues/1910
   */
  shouldStopStreaming?: ShouldStopStreaming
  /**
   * The maximum length of the response. If the response exceeds this length,
   * the chat will stop and return an error.
   */
  maxLength?: number
}): Promise<Either<string, T>> => {
  const {
    transform,
    retries = defaults.retries,
    isJson = false,
    grammar,
    messages,
    model = defaults.model
  } = options

  if (isJson === 'object' && grammar) {
    throw new Error('Cannot specify both isJson="object" and grammar')
  }

  if (isJson === 'any' && !grammar) {
    throw new Error('Must specify grammar when isJson is "any"')
  }

  if (isJson && options.shouldStopStreaming) {
    throw new Error(stripIndent`
      Cannot specify shouldStopStreaming when isJson is true,
      as the streaming is stopped automatically when the JSON is completed.
    `)
  }

  const shouldStopStreaming: ShouldStopStreaming = isJson
    ? ({ fullResponse, responseChunk }) => {
        if (responseChunk.trim() === '') {
          try {
            JSON.parse(fullResponse)
            return true
          } catch (err) {}
        }
        return false
      }
    : options.shouldStopStreaming || (() => false)

  const response = await ollama.chat({
    model,
    messages,
    format: isJson === 'object' ? 'json' : undefined,
    stream: true,
    options: {
      // @ts-expect-error: ollama-js types are not up to date with the patch
      // we made to Ollama When the types are updated, we can remove this
      // line, and probably also the patched version is no longer needed.
      grammar,
      top_k: options.topK,
      top_p: options.topP,
      temperature: options.temperature,
      stop: options.stop,
      repeat_last_n: options.repeatLastN,
      repeat_penalty: options.repeatPenalty,
      // A token is roughly 4 characters. Furthermore, -2 means "fill in the context".
      num_predict:
        // typeof options.maxLength === 'number' ? options.maxLength / 4 : -2
        -1
    }
  })

  log('generating response')
  let responseText = ''
  try {
    for await (const part of response) {
      responseText += part.message.content

      logWrite(part.message.content)

      if (
        shouldStopStreaming({
          fullResponse: responseText,
          responseChunk: part.message.content
        })
      ) {
        ollama.abort()
        break
      }

      if (options.maxLength && responseText.length > options.maxLength) {
        ollama.abort()
        return left('Response length exceeded')
      }
    }
  } catch (err) {
  } finally {
    // add a newline after the last message
    logLine()
  }

  log('parsing response')

  const responseObject = tryCatch(() => {
    return isJson ? JSON.parse(responseText) : responseText
  })

  const result = responseObject.chain((r) => {
    return transform ? transform(r) : right(r)
  })

  return asyncChainLeft(result, async (error) => {
    if (retries <= 0) {
      log('retries exhausted')
      return left(error)
    }
    log('error received, retrying')
    logLine('user:', error)
    return await chat({
      ...options,
      messages: [
        ...(messages || []),
        {
          role: 'assistant',
          content: responseText
        },
        {
          role: 'user',
          content: error
        }
      ],
      retries: retries - 1
    })
  })
}
