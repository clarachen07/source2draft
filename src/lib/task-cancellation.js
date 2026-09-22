export function createTaskCancelledError(reason = '用户通过 Slack 停止任务') {
  const error = new Error(reason);
  error.name = 'AbortError';
  error.code = 'TASK_CANCELLED';
  error.stage = 'cancelled';
  return error;
}

export function cancellationErrorFromSignal(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return createTaskCancelledError();
}

export function throwIfTaskCancelled(signal) {
  if (signal?.aborted) throw cancellationErrorFromSignal(signal);
}

export function isTaskCancelled(error, signal) {
  return Boolean(
    signal?.aborted
    || error?.code === 'TASK_CANCELLED'
    || error?.stage === 'cancelled'
  );
}

const FETCH_BASE_TRANSPORT = Symbol('shallow.fetchBaseTransport');
const FETCH_REBIND_TRANSPORT = Symbol('shallow.fetchRebindTransport');

export function withTaskCancellation(fetchFn, signal) {
  if (!signal) return fetchFn;
  const wrapped = (resource, options = {}) => {
    throwIfTaskCancelled(signal);
    const requestSignal = options?.signal;
    const combinedSignal = requestSignal && requestSignal !== signal
      ? AbortSignal.any([signal, requestSignal])
      : signal;
    return fetchFn(resource, { ...options, signal: combinedSignal });
  };
  const rebindInner = fetchFn?.[FETCH_REBIND_TRANSPORT];
  Object.defineProperties(wrapped, {
    [FETCH_BASE_TRANSPORT]: {
      value: fetchFn?.[FETCH_BASE_TRANSPORT] || fetchFn,
    },
    [FETCH_REBIND_TRANSPORT]: {
      value: (nextTransport) => withTaskCancellation(
        rebindInner ? rebindInner(nextTransport) : nextTransport,
        signal,
      ),
    },
  });
  return wrapped;
}

// Safe downloads replace the lowest-level transport after DNS validation while preserving cancellation and
// observability decorators. Do not compare function identity with globalThis.fetch: cancellation decoration
// would silently disable DNS pinning.
export function fetchUsesGlobalTransport(fetchFn) {
  return (fetchFn?.[FETCH_BASE_TRANSPORT] || fetchFn) === globalThis.fetch;
}

export function rebindFetchTransport(fetchFn, nextTransport) {
  const rebind = fetchFn?.[FETCH_REBIND_TRANSPORT];
  return rebind ? rebind(nextTransport) : nextTransport;
}
