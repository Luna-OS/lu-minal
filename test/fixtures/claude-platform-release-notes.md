---
title: Claude Platform release notes
url: https://platform.claude.com/docs/en/release-notes/overview
description: Updates to the Claude Platform, including the Claude API, client SDKs, and the Claude Console.
---

The Claude Platform release notes list changes to the Claude API, the client SDKs, and the Claude Console, newest first.

<Tip>
  For release notes on Claude Apps, see the [Release notes for Claude Apps in the Claude Help Center](https://support.claude.com/en/articles/12138966-release-notes).

  For updates to Claude Code, see the [complete CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) in the `claude-code` repository.
</Tip>

### October 22, 2026

* We've launched [Claude Models on Google Cloud (Anthropic managed)](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/anthropic-managed), the Claude API operated by Anthropic and reached through your Google Cloud project. Google Cloud IAM controls access. Google Cloud Marketplace handles billing.
* [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) is available for Claude Opus 5.5 on Claude Models on Google Cloud (Anthropic managed).

### October 21, 2026

* We've released API version `2026-10-21`. [Migrating to API version 2026-10-21](https://platform.claude.com/docs/en/api/migration-2026-10-21) shows how to upgrade.
* We've released new versions of the [client SDKs](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) and the [`ant` CLI](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart) that send API version `2026-10-21` by default: Python SDK 2.0.0, TypeScript SDK 1.0.0, C# SDK 13.0.0, Go SDK 2.0.0, Java SDK 3.0.0, PHP SDK 1.0.0, Ruby SDK 2.0.0, and `ant` CLI 2.0.0. See [Switch to 2026-10-21](https://platform.claude.com/docs/en/api/migration-2026-10-21#upgrade).
* The new SDK and CLI versions also have breaking changes that don't depend on the API version, and they are licensed under Apache 2.0 instead of the MIT License. See [SDK and CLI changes](https://platform.claude.com/docs/en/api/migration-2026-10-21#sdk-changes).
* We've added the `enforcement_status` and `enforcement_actions` fields to [user profiles](https://platform.claude.com/docs/en/manage-claude/user-profiles), so you can see whether Anthropic has restricted or banned one of your end customers. To find the profiles that have an open restriction or ban, [list your profiles](https://platform.claude.com/docs/en/api/user_profiles/list) with the new `enforcement_status[]` filter. See [Check whether Anthropic has restricted or banned a profile](https://platform.claude.com/docs/en/manage-claude/user-profiles#check-whether-anthropic-has-restricted-or-banned-a-profile).

### October 20, 2026

* The [Claude Tag API](https://platform.claude.com/docs/en/manage-claude/claude-tag-api) is available in beta for Claude Enterprise organizations with the `experimental-claude-tag-2026-10-21` beta header. Its `/v1/organizations/claude_tag/` endpoints read and change [Claude Tag](https://claude.com/docs/claude-tag/overview) settings on Slack channels and Slack workspaces, show which settings apply in a channel and where each comes from, and attach Access bundles. Call it with an Admin API key that your primary owner creates in claude.ai with the `read:claude_tag` or `write:claude_tag` scope. It is not available to Claude Platform (Claude Console) organizations.

### October 20, 2026

* [Inference hooks](https://platform.claude.com/docs/en/manage-claude/inference-hooks) are out of beta for Claude Enterprise organizations.
* We've launched [user profiles](https://platform.claude.com/docs/en/manage-claude/user-profiles), so you can tell Anthropic which of your end customers each API request is for. If you operate a platform or gateway, or resell API access, a safety enforcement action can then apply to one end customer instead of your whole organization. The SDK and the `ant` CLI support the new [`/v1/user_profiles` endpoints](https://platform.claude.com/docs/en/api/user_profiles).
* We've added [organization webhooks](https://platform.claude.com/docs/en/manage-claude/organization-webhooks) to the [Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api), in beta with the `webhooks-2026-10-07` beta header. Its [`/v1/organizations/webhooks` endpoints](https://platform.claude.com/docs/en/api/beta/organization/webhooks) register webhook endpoints for two event types: one for when Anthropic restricts or bans one of your organization's user profiles, and one for when the restriction or ban ends. To request access, contact your Anthropic account team.
* Organization admins can now turn off web fetch for their organization on the [**Capabilities**](https://platform.claude.com/settings/capabilities) page of the Claude Console. With web fetch off, a Messages API request that includes the web fetch tool fails with a 400 error. In a Claude Managed Agents session, `web_fetch` calls return an error result to the agent instead. With web fetch on, admins can also set allowed or blocked domains for web fetch on the same page. See [How to use web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool#how-to-use-web-fetch) and [Domain filtering](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools#domain-filtering).
* In Claude Managed Agents, the [`web_fetch` tool](https://platform.claude.com/docs/en/managed-agents/tools#available-tools) now follows your organization's web fetch domain restrictions set on the [**Capabilities**](https://platform.claude.com/settings/capabilities) page of the Claude Console. A URL, including one reached by a redirect, must pass both the organization's list and the `allowed_domains` or `blocked_domains` list on the agent's `web_fetch` tool. See [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions).
* In Claude Managed Agents, sessions follow your organization's web search settings on the [**Capabilities**](https://platform.claude.com/settings/capabilities) page of the Claude Console: the **Allow web search** setting since October 6, and its web search domain restrictions since October 14. The agent receives only the search results that both the organization's domain restrictions and the `allowed_domains` or `blocked_domains` list on the agent's [`web_search` tool](https://platform.claude.com/docs/en/managed-agents/tools#available-tools) allow. See [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions).

### October 15, 2026

* We've added `capabilities.thinking.types.between_tools` to the [Models API](https://platform.claude.com/docs/en/api/models/list). `GET /v1/models` and `GET /v1/models/{model_id}` now report whether each model accepts `thinking: {type: "between_tools"}`, which turns off up-front thinking. See [Using the Models API](https://platform.claude.com/docs/en/models/overview#using-the-models-api).
* The [Compliance API](https://platform.claude.com/docs/en/manage-claude/compliance-api) now returns the text each organization member saved as **Instructions for Claude** in claude.ai and as **Global instructions** in Cowork, in beta for Claude Enterprise organizations. Call `GET /v1/compliance/organizations/{org_uuid}/user_preferences` with your existing Compliance Access Key and the `read:compliance_user_data` scope. See [List user preferences](https://platform.claude.com/docs/en/manage-claude/compliance-org-data#list-user-preferences).
* [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) is out of research preview for Claude Opus 5.5, and you no longer need to request access. Requests to Claude Opus 5.5 no longer require the `fast-mode-2026-02-01` beta header, and requests that still send it keep working. Claude Opus 5.5 now has a default fast mode rate limit in the Start, Build, and Scale usage tiers. Fast mode for Claude Opus 5 and Claude Opus 4.8 remains in research preview. Keep sending the beta header with fast mode requests to those models.
* [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) for Claude Opus 5.5 is now available on [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry) for deployments hosted on Azure.

### October 14, 2026
