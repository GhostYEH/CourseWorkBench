

// —— 统一响应边界 ——

/** 所有领域 HTTP 响应共享同一信封：成功带 data，失败带 error。 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    pending: boolean;
    details?: Record<string, unknown>;
  };
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;
