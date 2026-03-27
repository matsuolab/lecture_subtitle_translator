import { useReducer, useCallback } from 'react'

interface HistoryState<T> {
  past: T[]
  present: T
  future: T[]
}

type HistoryAction<T> =
  | { type: 'PUSH'; payload: T }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'RESET'; payload: T }

function historyReducer<T>(state: HistoryState<T>, action: HistoryAction<T>): HistoryState<T> {
  switch (action.type) {
    case 'PUSH':
      return { past: [...state.past, state.present], present: action.payload, future: [] }
    case 'UNDO': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] }
    }
    case 'REDO': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return { past: [...state.past, state.present], present: next, future: state.future.slice(1) }
    }
    case 'RESET':
      return { past: [], present: action.payload, future: [] }
  }
}

export function useHistory<T>(initialState: T) {
  const [state, dispatch] = useReducer(historyReducer<T>, {
    past: [],
    present: initialState,
    future: [],
  })

  const push  = useCallback((next: T) => dispatch({ type: 'PUSH',  payload: next }), [])
  const undo  = useCallback(() => dispatch({ type: 'UNDO' }), [])
  const redo  = useCallback(() => dispatch({ type: 'REDO' }), [])
  const reset = useCallback((next: T) => dispatch({ type: 'RESET', payload: next }), [])

  return {
    current: state.present,
    push,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}
