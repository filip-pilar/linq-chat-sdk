import { APIError, LinqAPIV3 } from "@linqapp/sdk"
import { HTTPError } from "nitro"

const DEFAULT_LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner"

export const LINQ_API_TOKEN_ENV_NAME = "LINQ_API_TOKEN"
export const LINQ_WEBHOOK_VERSION = "2026-02-03"

export type LinqWebhookSubscription = Awaited<
  ReturnType<LinqAPIV3["webhookSubscriptions"]["create"]>
>

export function getLinqApiBaseUrl(): string {
  return process.env.LINQ_API_BASE_URL?.trim() || DEFAULT_LINQ_API_BASE_URL
}

export function getLinqApiToken(): string | null {
  return process.env[LINQ_API_TOKEN_ENV_NAME]?.trim() || null
}

export function hasLinqApiToken(): boolean {
  return getLinqApiToken() !== null
}

export function buildLinqWebhookUrl(publicBaseUrl: string): string {
  let base: URL

  try {
    base = new URL(publicBaseUrl)
  } catch {
    throw new HTTPError({
      status: 400,
      message: "Public app URL must be a valid absolute URL.",
    })
  }

  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new HTTPError({
      status: 400,
      message: "Public app URL must use http or https.",
    })
  }

  const normalizedBase = new URL(base.toString())
  if (!normalizedBase.pathname.endsWith("/")) {
    normalizedBase.pathname = `${normalizedBase.pathname}/`
  }

  const webhookUrl = new URL("api/webhooks/linq", normalizedBase)
  webhookUrl.searchParams.set("version", LINQ_WEBHOOK_VERSION)
  return webhookUrl.toString()
}

function createLinqApiClient(): LinqAPIV3 {
  const token = getLinqApiToken()

  if (!token) {
    throw new HTTPError({
      status: 400,
      message: `${LINQ_API_TOKEN_ENV_NAME} is not configured.`,
    })
  }

  return new LinqAPIV3({
    apiKey: token,
    baseURL: getLinqApiBaseUrl(),
  })
}

function getLinqApiErrorMessage(error: unknown): string {
  if (error instanceof APIError && error.message) {
    return error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return "Linq API request failed."
}

export async function createLinqWebhookSubscription(targetUrl: string): Promise<LinqWebhookSubscription> {
  try {
    const subscription = await createLinqApiClient().webhookSubscriptions.create({
      target_url: targetUrl,
      subscribed_events: ["message.received"],
    })

    return subscription
  } catch (error) {
    if (error instanceof HTTPError) {
      throw error
    }

    throw new HTTPError({
      status: 502,
      message: getLinqApiErrorMessage(error),
    })
  }
}
