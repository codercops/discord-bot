// The funding manifest for CODERCOPS's open source projects, in the
// funding.json format (https://fundingjson.org). Funders such as FLOSS/fund
// read it from https://oss.codercops.com/funding.json.
//
// Every URL in it on another host has to point back here: each project site
// and each repo carries a .well-known/funding-manifest-urls file that lists
// MANIFEST_URL. Change a project's site or default branch and that file has to
// move with it.

export const MANIFEST_URL = "https://oss.codercops.com/funding.json";

// GitHub Sponsors for the org is added here once the codercops listing is live.
const SPONSORS_URL = "https://github.com/sponsors/anurag629";

const project = (
  guid: string,
  name: string,
  description: string,
  site: string,
  branch: string,
  tags: string[]
) => ({
  guid,
  name,
  description,
  webpageUrl: { url: site, wellKnown: `${site}/.well-known/funding-manifest-urls` },
  repositoryUrl: {
    url: `https://github.com/codercops/${guid}`,
    wellKnown: `https://github.com/codercops/${guid}/blob/${branch}/.well-known/funding-manifest-urls`,
  },
  licenses: ["spdx:MIT"],
  tags,
});

export const manifest = {
  $schema: "https://fundingjson.org/schema/v1.1.0.json",
  version: "v1.1.0",
  entity: {
    type: "organisation",
    role: "owner",
    name: "CODERCOPS",
    email: "hello@codercops.com",
    description:
      "CODERCOPS is a small software studio in India. We build and maintain four MIT-licensed developer tools: an embeddable AI chat widget, an OG image generator, a set of in-browser developer utilities, and the bot that runs our contributor community. All of them are free to use and self-host. We don't sell them or a hosted version of them. Close to 60 people have had pull requests merged across the four repos, many of them first-time open source contributors.",
    webpageUrl: { url: "https://oss.codercops.com" },
  },
  projects: [
    project(
      "chatcops",
      "ChatCops",
      "An embeddable AI chatbot widget you add to any website with one script tag. It works with Claude, OpenAI and Gemini, and comes with lead capture, a knowledge base and translations. Published on npm as @chatcops/widget, @chatcops/server and @chatcops/core.",
      "https://chat.codercops.com",
      "dev",
      ["ai", "chatbot", "widget", "typescript", "llm"]
    ),
    project(
      "ogcops",
      "OGCOPS",
      "A free Open Graph image generator with over 100 templates, previews for 8 platforms and a free REST API. No login and no watermarks.",
      "https://og.codercops.com",
      "dev",
      ["open-graph", "image-generation", "seo", "typescript", "web"]
    ),
    project(
      "toolbelt",
      "toolbelt",
      "Developer tools that run entirely in the browser, so nothing is uploaded: a JSON formatter, JWT decoder, Base64, regex tester, invoice generator and more.",
      "https://tools.codercops.com",
      "develop",
      ["developer-tools", "privacy", "json", "web", "typescript"]
    ),
    {
      ...project(
        "discord-bot",
        "CODERCOPS community bot",
        "The Cloudflare Worker behind our contributor community. It posts starter issues, releases and merged PRs to Discord and runs the public monthly contributor leaderboard at oss.codercops.com.",
        "https://oss.codercops.com",
        "develop",
        ["community", "discord", "github", "cloudflare-workers", "typescript"]
      ),
      // Same host as this manifest, so the page needs no extra proof.
      webpageUrl: { url: "https://oss.codercops.com" },
    },
  ],
  funding: {
    channels: [
      {
        guid: "github-sponsors",
        type: "payment-provider",
        address: SPONSORS_URL,
        description: "GitHub Sponsors, one-time or monthly.",
      },
      {
        guid: "bank",
        type: "bank",
        address: "hello@codercops.com",
        description: "Bank transfer to our account in India. Write to us for the details.",
      },
      {
        guid: "paypal",
        type: "payment-provider",
        address: "https://www.paypal.com/paypalme/codercops",
      },
      {
        guid: "buymeacoffee",
        type: "payment-provider",
        address: "https://buymeacoffee.com/anurag629",
      },
    ],
    plans: [
      {
        guid: "maintainer-time",
        status: "active",
        name: "Maintainer time",
        description:
          "Paid hours for reviewing pull requests, triaging issues, mentoring new contributors and shipping releases across the four projects.",
        amount: 12000,
        currency: "USD",
        frequency: "yearly",
        channels: ["github-sponsors", "bank"],
      },
      {
        guid: "infrastructure",
        status: "active",
        name: "Hosting and infrastructure",
        description: "Cloudflare Workers, storage, domains and the AI API usage behind the public demos.",
        amount: 1200,
        currency: "USD",
        frequency: "yearly",
        channels: ["github-sponsors", "bank"],
      },
      {
        guid: "any-amount",
        status: "active",
        name: "Any amount",
        description: "Chip in whatever you like, once or every month.",
        amount: 0,
        currency: "USD",
        frequency: "one-time",
        channels: ["github-sponsors", "paypal", "buymeacoffee"],
      },
    ],
  },
};
