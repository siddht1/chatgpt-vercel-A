import type { APIRoute } from "astro"
import type { ParsedEvent, ReconnectInterval } from "eventsource-parser"
import { createParser } from "eventsource-parser"
import type { ChatMessage, Model } from "~/types"
import { countTokens } from "~/utils/tokens"
import { splitKeys, randomKey, fetchWithTimeout } from "~/utils"
import { defaultMaxInputTokens, defaultModel } from "~/system"

export const config = {
  runtime: "edge",

  regions: [
    "arn1",
    "bom1",
    "bru1",
    "cdg1",
    "cle1",
    "cpt1a",
    "dub1",
    "fra1",
    "gru1",
    "hnd1",
    "iad1",
    "icn1",
    "kix1",
    "lhr1",
    "pdx1",
    "sfo1",
    "sin1",
    "syd1"
  ]
}

export const localKey = import.meta.env.OPENAI_API_KEY || ""

export const baseURL = import.meta.env.NOGFW
  ? "api.openai.com"
  : (import.meta.env.OPENAI_API_BASE_URL || "api.openai.com").replace(
      /^https?:\/\//,
      ""
    )

const timeout = Number(import.meta.env.TIMEOUT)

let maxInputTokens = defaultMaxInputTokens
const _ = import.meta.env.MAX_INPUT_TOKENS
if (_) {
  try {
    if (Number.isInteger(Number(_))) {
      maxInputTokens = Object.entries(maxInputTokens).reduce((acc, [k]) => {
        acc[k as Model] = Number(_)
        return acc
      }, {} as typeof maxInputTokens)
    } else {
      maxInputTokens = {
        ...maxInputTokens,
        ...JSON.parse(_)
      }
    }
  } catch (e) {
    console.error("Error parsing MAX_INPUT_TOKEN:", e)
  }
}

const pwd = import.meta.env.PASSWORD

export const post: APIRoute = async context => {
  try {
    const body: {
      messages?: ChatMessage[]
      key?: string
      temperature: number
      password?: string
      model: Model
    } = await context.request.json()
    const {
      messages,
      key = localKey,
      temperature = 0.6,
      password,
      model = defaultModel
    } = body

    if (pwd && pwd !== password) {
      throw new Error("The password is incorrect, please contact the webmaster.")
    }

    if (!messages?.length) {
      throw new Error(" No text was entered")
    } else {
      const content = messages.at(-1)!.content.trim()
      if (content.startsWith("Check the balance")) {
        if (key !== localKey) {
          const billings = await Promise.all(
            splitKeys(key).map(k => fetchBilling(k))
          )
          return new Response(await genBillingsTable(billings))
        } else {
          throw new Error("If the OpenAI API key is not filled in, the built-in key will not be queried.")
        }
      } else if (content.startsWith("sk-")) {
        const billings = await Promise.all(
          splitKeys(content).map(k => fetchBilling(k))
        )
        return new Response(await genBillingsTable(billings))
      }
    }

    const apiKey = randomKey(splitKeys(key))

    if (!apiKey) throw new Error("The OpenAI API key is not filled in, or the key is incorrect.")

    const tokens = messages.reduce((acc, cur) => {
      const tokens = countTokens(cur.content)
      return acc + tokens
    }, 0)

    if (
      tokens > (body.key ? defaultMaxInputTokens[model] : maxInputTokens[model])
    ) {
      if (messages.length > 1)
        throw new Error(
          `This conversation is too long because the continuous conversation option is turned on, please clear some of the content and try again, or turn off the continuous conversation option.`
        )
      else throw new Error("It's too long, shorten it a bit.")
    }

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const rawRes = await fetchWithTimeout(
      `https://${baseURL}/v1/chat/completions`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        timeout: !timeout || Number.isNaN(timeout) ? 30000 : timeout,
        method: "POST",
        body: JSON.stringify({
          model: model || "gpt-3.5-turbo",
          messages: messages.map(k => ({ role: k.role, content: k.content })),
          temperature,
          // max_tokens: 4096 - tokens,
          stream: true
        })
      }
    ).catch(err => {
      return new Response(
        JSON.stringify({
          error: {
            message: err.message
          }
        }),
        { status: 500 }
      )
    })

    if (!rawRes.ok) {
      return new Response(rawRes.body, {
        status: rawRes.status,
        statusText: rawRes.statusText
      })
    }

    const stream = new ReadableStream({
      async start(controller) {
        const streamParser = (event: ParsedEvent | ReconnectInterval) => {
          if (event.type === "event") {
            const data = event.data
            if (data === "[DONE]") {
              controller.close()
              return
            }
            try {
              const json = JSON.parse(data)
              const text = json.choices[0].delta?.content
              const queue = encoder.encode(text)
              controller.enqueue(queue)
            } catch (e) {
              controller.error(e)
            }
          }
        }
        const parser = createParser(streamParser)
        for await (const chunk of rawRes.body as any) {
          parser.feed(decoder.decode(chunk))
        }
      }
    })

    return new Response(stream)
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: err.message
        }
      }),
      { status: 400 }
    )
  }
}

type Billing = {
  key: string
  rate: number
  totalGranted: number
  totalUsed: number
  totalAvailable: number
}

export async function fetchBilling(key: string): Promise<Billing> {
  function formatDate(date: any) {
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, "0")
    const day = date.getDate().toString().padStart(2, "0")
    return `${year}-${month}-${day}`
  }
  try {
    const now = new Date()
    const startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)

   
    const urlSubscription =
      "https://api.openai.com/v1/dashboard/billing/subscription" 
    const urlUsage = `https://api.openai.com/v1/dashboard/billing/usage?start_date=${formatDate(
      startDate
    )}&end_date=${formatDate(endDate)}` 
    const headers = {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    }

   
    const subscriptionData = await fetch(urlSubscription, { headers }).then(r =>
      r.json()
    )
    if (subscriptionData.error?.message)
      throw new Error(subscriptionData.error.message)
    const totalGranted = subscriptionData.hard_limit_usd
  
    const usageData = await fetch(urlUsage, { headers }).then(r => r.json())
    const totalUsed = usageData.total_usage / 100
  
    const totalAvailable = totalGranted - totalUsed
    return {
      totalGranted,
      totalUsed,
      totalAvailable,
      key,
      rate: totalAvailable / totalGranted
    }
  } catch (e) {
    console.error(e)
    return {
      key,
      rate: 0,
      totalGranted: 0,
      totalUsed: 0,
      totalAvailable: 0
    }
  }
}

export async function genBillingsTable(billings: Billing[]) {
  const table = billings
    .sort((m, n) => (m.totalGranted === 0 ? -1 : n.rate - m.rate))
    .map((k, i) => {
      if (k.totalGranted === 0)
        return `| ${k.key.slice(0, 8)} | 不可用 | —— | —— |`
      return `| ${k.key.slice(0, 8)} | ${k.totalAvailable.toFixed(4)}(${(
        k.rate * 100
      ).toFixed(1)}%) | ${k.totalUsed.toFixed(4)} | ${k.totalGranted} |`
    })
    .join("\n")

  return `| Key  | Remaining | Used | Gross magnitude |
| ---- | ---- | ---- | ------ |
${table}
`
}
