import {
  createHelloRequest,
  NATIVE_HOST_NAME,
  parseHelloResponse,
  type NativeHello,
} from '../native/protocol';

export async function detectNativeCompanion(): Promise<NativeHello> {
  const request = createHelloRequest();
  let response: unknown;
  try {
    response = await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, request);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not connect to hsyncd. Install and register the companion, then try again. ${detail}`);
  }
  return parseHelloResponse(response, request.requestId);
}
