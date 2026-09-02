// 服务定位器：路由层通过它获取 Phase C/D 才装配的服务，避免模块循环依赖

export interface ChannelTestResult {
  success: boolean;
  message?: string;
  [k: string]: unknown;
}

export interface ProviderServiceLike {
  testChannel(channelId: number): Promise<ChannelTestResult>;
  syncChannel(channelId: number): Promise<unknown>;
  testModel(modelId: number): Promise<Record<string, unknown>>;
  batchTest(body: unknown): Promise<unknown>;
}

export interface RuntimeReloadable {
  rebuild(): void;
}

let providerService: ProviderServiceLike | null = null;
let runtime: RuntimeReloadable | null = null;

export function registerProviderService(s: ProviderServiceLike): void {
  providerService = s;
}
export function getProviderService(): ProviderServiceLike | null {
  return providerService;
}
export function registerRuntime(r: RuntimeReloadable): void {
  runtime = r;
}
export function getRuntime(): RuntimeReloadable | null {
  return runtime;
}
