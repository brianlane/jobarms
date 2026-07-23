import Stripe from "stripe";
import { requireEnv } from "@/lib/env";

let cached: Stripe | null = null;

/** Lazy singleton Stripe client (test keys until launch). */
export function stripeClient(): Stripe {
  if (!cached) {
    cached = new Stripe(requireEnv("STRIPE_SECRET_KEY"));
  }
  return cached;
}
