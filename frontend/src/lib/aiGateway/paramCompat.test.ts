import { afterEach, describe, expect, it } from 'vitest'
import {
  detectUnsupportedParam,
  getLearnedUnsupportedParams,
  learnUnsupportedParam,
  resetParamCompat,
  stripLearnedUnsupportedParams,
} from './paramCompat'

describe('paramCompat', () => {
  afterEach(() => {
    resetParamCompat()
  })

  describe('detectUnsupportedParam', () => {
    it('detects a removable sampling parameter reported via error.param with code=unsupported_value', () => {
      const detail = JSON.stringify({
        error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", param: 'temperature', code: 'unsupported_value' },
      })
      expect(detectUnsupportedParam(detail)).toBe('temperature')
    })

    it('detects a removable sampling parameter reported via error.param with code=unsupported_parameter', () => {
      const detail = JSON.stringify({
        error: { message: 'top_p is not supported', param: 'top_p', code: 'unsupported_parameter' },
      })
      expect(detectUnsupportedParam(detail)).toBe('top_p')
    })

    it('falls back to extracting the parameter name from error.message when error.param is absent', () => {
      const detail = JSON.stringify({
        error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", code: 'unsupported_value' },
      })
      expect(detectUnsupportedParam(detail)).toBe('temperature')
    })

    it('does not treat a disallowed parameter (e.g. "model") as removable even if the server reports it', () => {
      const detail = JSON.stringify({
        error: { message: 'model is invalid', param: 'model', code: 'unsupported_value' },
      })
      expect(detectUnsupportedParam(detail)).toBeNull()
    })

    it('does not treat a disallowed parameter named in the message as removable', () => {
      const detail = JSON.stringify({
        error: { message: "Unsupported value: 'messages' is invalid.", code: 'unsupported_value' },
      })
      expect(detectUnsupportedParam(detail)).toBeNull()
    })

    it('ignores error codes other than unsupported_value / unsupported_parameter', () => {
      const detail = JSON.stringify({
        error: { message: 'temperature is bad', param: 'temperature', code: 'invalid_request_error' },
      })
      expect(detectUnsupportedParam(detail)).toBeNull()
    })

    it('returns null for non-JSON detail bodies', () => {
      expect(detectUnsupportedParam('not json at all')).toBeNull()
    })

    it('returns null when the body has no error field', () => {
      expect(detectUnsupportedParam(JSON.stringify({ message: 'plain error' }))).toBeNull()
    })
  })

  describe('learnUnsupportedParam / getLearnedUnsupportedParams / stripLearnedUnsupportedParams', () => {
    it('learns a parameter for a baseUrl+model key and strips it from subsequent request bodies', () => {
      const detail = JSON.stringify({
        error: { message: "Unsupported value: 'temperature'", param: 'temperature', code: 'unsupported_value' },
      })

      const learned = learnUnsupportedParam('https://api.openai.com/v1', 'gpt-5.4-mini', detail)
      expect(learned).toBe('temperature')
      expect(getLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-5.4-mini').has('temperature')).toBe(true)

      const body = { model: 'gpt-5.4-mini', messages: [], temperature: 0 }
      const stripped = stripLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-5.4-mini', body)
      expect(stripped).not.toHaveProperty('temperature')
      expect(stripped.model).toBe('gpt-5.4-mini')
      expect(stripped.messages).toEqual([])
    })

    it('scopes learned parameters to the specific baseUrl+model combination', () => {
      const detail = JSON.stringify({
        error: { message: "Unsupported value: 'temperature'", param: 'temperature', code: 'unsupported_value' },
      })
      learnUnsupportedParam('https://api.openai.com/v1', 'gpt-5.4-mini', detail)

      // 別モデルには影響しない
      const otherModelBody = { model: 'gpt-4o-mini', temperature: 0.2 }
      expect(stripLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-4o-mini', otherModelBody)).toEqual(otherModelBody)

      // 別 baseUrl にも影響しない
      const otherBaseUrlBody = { model: 'gpt-5.4-mini', temperature: 0.2 }
      expect(stripLearnedUnsupportedParams('http://127.0.0.1:1234/v1', 'gpt-5.4-mini', otherBaseUrlBody)).toEqual(otherBaseUrlBody)
    })

    it('returns the same body reference (no unnecessary copy) when nothing has been learned for the key', () => {
      const body = { model: 'gpt-5.4-mini', temperature: 0.2 }
      expect(stripLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-5.4-mini', body)).toBe(body)
    })

    it('does not learn a disallowed parameter (e.g. "model"), so a 400 naming "model" is left untouched by stripping', () => {
      const detail = JSON.stringify({
        error: { message: 'model is invalid', param: 'model', code: 'unsupported_value' },
      })
      const learned = learnUnsupportedParam('https://api.openai.com/v1', 'gpt-5.4-mini', detail)
      expect(learned).toBeNull()

      const body = { model: 'gpt-5.4-mini', messages: [] }
      expect(stripLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-5.4-mini', body)).toEqual(body)
    })

    it('clears all learned parameters via resetParamCompat', () => {
      const detail = JSON.stringify({
        error: { message: "Unsupported value: 'temperature'", param: 'temperature', code: 'unsupported_value' },
      })
      learnUnsupportedParam('https://api.openai.com/v1', 'gpt-5.4-mini', detail)
      expect(getLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-5.4-mini').size).toBe(1)

      resetParamCompat()
      expect(getLearnedUnsupportedParams('https://api.openai.com/v1', 'gpt-5.4-mini').size).toBe(0)
    })
  })
})
