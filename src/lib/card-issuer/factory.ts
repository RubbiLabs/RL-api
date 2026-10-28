import type { Env } from "../../config/index.js"
import type { ICardIssuer } from "./index.js"
import { MockCardIssuer } from "./mock.adapter.js"
import { SudoCardIssuer } from "./sudo.adapter.js"

/** Picks the card issuer from CARD_ISSUER (mock by default). */
export function createCardIssuer(env: Pick<Env, "CARD_ISSUER" | "SUDO_API_KEY" | "SUDO_BASE_URL" | "SUDO_DEFAULT_CUSTOMER_ID">): ICardIssuer {
  if (env.CARD_ISSUER === "sudo") {
    if (!env.SUDO_API_KEY) {
      throw new Error("CARD_ISSUER=sudo requires SUDO_API_KEY")
    }
    return new SudoCardIssuer({
      apiKey: env.SUDO_API_KEY,
      baseUrl: env.SUDO_BASE_URL,
      defaultCustomerId: env.SUDO_DEFAULT_CUSTOMER_ID,
    })
  }
  return new MockCardIssuer()
}
