declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    ALLOWED_EMAILS: string;
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
  }
}
