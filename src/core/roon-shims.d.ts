declare module "@roonlabs/node-roon-api" {
  type RoonApiOptions = {
    extension_id: string
    display_name: string
    display_version: string
    publisher: string
    email: string
    log_level?: string
    required_services?: unknown[]
    optional_services?: unknown[]
    set_persisted_state?: (state: Record<string, unknown>) => void
    get_persisted_state?: () => Record<string, unknown>
    core_paired?: (core: unknown) => void
    core_unpaired?: (core: unknown) => void
  }
  class RoonApi {
    constructor(opts: RoonApiOptions)
    start_discovery(): void
    save_config(key: string, value: unknown): void
    load_config(key: string): unknown
    services: Record<string, unknown>
  }
  export default RoonApi
}

declare module "node-roon-api-transport" {
  const svc: unknown
  export default svc
}
declare module "node-roon-api-browse" {
  const svc: unknown
  export default svc
}
declare module "node-roon-api-image" {
  const svc: unknown
  export default svc
}
declare module "node-roon-api-status" {
  class RoonApiStatus {
    constructor(roon: unknown)
    set_status(message: string, isError: boolean): void
  }
  export default RoonApiStatus
}
