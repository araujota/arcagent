/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as __tests___helpers from "../__tests__/helpers.js";
import type * as activityFeed from "../activityFeed.js";
import type * as agentHellos from "../agentHellos.js";
import type * as agentRatings from "../agentRatings.js";
import type * as agentStats from "../agentStats.js";
import type * as apiKeys from "../apiKeys.js";
import type * as attemptWorkers from "../attemptWorkers.js";
import type * as attemptWorkersNode from "../attemptWorkersNode.js";
import type * as aws from "../aws.js";
import type * as bounties from "../bounties.js";
import type * as bountyClaims from "../bountyClaims.js";
import type * as codeChunks from "../codeChunks.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as devWorkspaces from "../devWorkspaces.js";
import type * as generatedTests from "../generatedTests.js";
import type * as http from "../http.js";
import type * as investorMetrics from "../investorMetrics.js";
import type * as lib_adfToMarkdown from "../lib/adfToMarkdown.js";
import type * as lib_attemptWorkerAuth from "../lib/attemptWorkerAuth.js";
import type * as lib_bddStepVerifier from "../lib/bddStepVerifier.js";
import type * as lib_bitbucket from "../lib/bitbucket.js";
import type * as lib_bountyResolvedEmail from "../lib/bountyResolvedEmail.js";
import type * as lib_chunker from "../lib/chunker.js";
import type * as lib_constantTimeEqual from "../lib/constantTimeEqual.js";
import type * as lib_embeddings from "../lib/embeddings.js";
import type * as lib_fees from "../lib/fees.js";
import type * as lib_gherkinValidator from "../lib/gherkinValidator.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_githubApp from "../lib/githubApp.js";
import type * as lib_gitlab from "../lib/gitlab.js";
import type * as lib_hmac from "../lib/hmac.js";
import type * as lib_htmlToMarkdown from "../lib/htmlToMarkdown.js";
import type * as lib_httpRetry from "../lib/httpRetry.js";
import type * as lib_languageDetector from "../lib/languageDetector.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_repoAuth from "../lib/repoAuth.js";
import type * as lib_repoMapper from "../lib/repoMapper.js";
import type * as lib_repoProviders from "../lib/repoProviders.js";
import type * as lib_secretCrypto from "../lib/secretCrypto.js";
import type * as lib_tierCalculation from "../lib/tierCalculation.js";
import type * as lib_treeSitter from "../lib/treeSitter.js";
import type * as lib_utils from "../lib/utils.js";
import type * as lib_waitlistEmail from "../lib/waitlistEmail.js";
import type * as lib_workProviders_asana from "../lib/workProviders/asana.js";
import type * as lib_workProviders_fetchWorkItem from "../lib/workProviders/fetchWorkItem.js";
import type * as lib_workProviders_jira from "../lib/workProviders/jira.js";
import type * as lib_workProviders_linear from "../lib/workProviders/linear.js";
import type * as lib_workProviders_monday from "../lib/workProviders/monday.js";
import type * as lib_workProviders_types from "../lib/workProviders/types.js";
import type * as lib_workspaceIsolation from "../lib/workspaceIsolation.js";
import type * as mcpAuditLogs from "../mcpAuditLogs.js";
import type * as mcpRegistrationLimits from "../mcpRegistrationLimits.js";
import type * as notifications from "../notifications.js";
import type * as orchestrator from "../orchestrator.js";
import type * as payments from "../payments.js";
import type * as pipelines_analyzeRequirements from "../pipelines/analyzeRequirements.js";
import type * as pipelines_clarifyRequirements from "../pipelines/clarifyRequirements.js";
import type * as pipelines_cleanupRepoData from "../pipelines/cleanupRepoData.js";
import type * as pipelines_dispatchVerification from "../pipelines/dispatchVerification.js";
import type * as pipelines_ensureDockerfile from "../pipelines/ensureDockerfile.js";
import type * as pipelines_fetchGherkinUrl from "../pipelines/fetchGherkinUrl.js";
import type * as pipelines_fetchRepo from "../pipelines/fetchRepo.js";
import type * as pipelines_fetchWorkItem from "../pipelines/fetchWorkItem.js";
import type * as pipelines_generateBDD from "../pipelines/generateBDD.js";
import type * as pipelines_generateTDD from "../pipelines/generateTDD.js";
import type * as pipelines_indexRepo from "../pipelines/indexRepo.js";
import type * as pipelines_parseRepo from "../pipelines/parseRepo.js";
import type * as pipelines_retrieveContext from "../pipelines/retrieveContext.js";
import type * as pipelines_validateTests from "../pipelines/validateTests.js";
import type * as platformStats from "../platformStats.js";
import type * as pmConnections from "../pmConnections.js";
import type * as providerConnections from "../providerConnections.js";
import type * as repoConnections from "../repoConnections.js";
import type * as repoMaps from "../repoMaps.js";
import type * as sanityGates from "../sanityGates.js";
import type * as savedRepos from "../savedRepos.js";
import type * as seed from "../seed.js";
import type * as stripe from "../stripe.js";
import type * as stripeHandshakeChecks from "../stripeHandshakeChecks.js";
import type * as submissions from "../submissions.js";
import type * as testBounties from "../testBounties.js";
import type * as testSuites from "../testSuites.js";
import type * as users from "../users.js";
import type * as verificationArtifacts from "../verificationArtifacts.js";
import type * as verificationJobs from "../verificationJobs.js";
import type * as verificationReceipts from "../verificationReceipts.js";
import type * as verificationSteps from "../verificationSteps.js";
import type * as verifications from "../verifications.js";
import type * as waitlist from "../waitlist.js";
import type * as workerCallbackNonces from "../workerCallbackNonces.js";
import type * as workspaceCrashReports from "../workspaceCrashReports.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "__tests__/helpers": typeof __tests___helpers;
  activityFeed: typeof activityFeed;
  agentHellos: typeof agentHellos;
  agentRatings: typeof agentRatings;
  agentStats: typeof agentStats;
  apiKeys: typeof apiKeys;
  attemptWorkers: typeof attemptWorkers;
  attemptWorkersNode: typeof attemptWorkersNode;
  aws: typeof aws;
  bounties: typeof bounties;
  bountyClaims: typeof bountyClaims;
  codeChunks: typeof codeChunks;
  conversations: typeof conversations;
  crons: typeof crons;
  devWorkspaces: typeof devWorkspaces;
  generatedTests: typeof generatedTests;
  http: typeof http;
  investorMetrics: typeof investorMetrics;
  "lib/adfToMarkdown": typeof lib_adfToMarkdown;
  "lib/attemptWorkerAuth": typeof lib_attemptWorkerAuth;
  "lib/bddStepVerifier": typeof lib_bddStepVerifier;
  "lib/bitbucket": typeof lib_bitbucket;
  "lib/bountyResolvedEmail": typeof lib_bountyResolvedEmail;
  "lib/chunker": typeof lib_chunker;
  "lib/constantTimeEqual": typeof lib_constantTimeEqual;
  "lib/embeddings": typeof lib_embeddings;
  "lib/fees": typeof lib_fees;
  "lib/gherkinValidator": typeof lib_gherkinValidator;
  "lib/github": typeof lib_github;
  "lib/githubApp": typeof lib_githubApp;
  "lib/gitlab": typeof lib_gitlab;
  "lib/hmac": typeof lib_hmac;
  "lib/htmlToMarkdown": typeof lib_htmlToMarkdown;
  "lib/httpRetry": typeof lib_httpRetry;
  "lib/languageDetector": typeof lib_languageDetector;
  "lib/llm": typeof lib_llm;
  "lib/repoAuth": typeof lib_repoAuth;
  "lib/repoMapper": typeof lib_repoMapper;
  "lib/repoProviders": typeof lib_repoProviders;
  "lib/secretCrypto": typeof lib_secretCrypto;
  "lib/tierCalculation": typeof lib_tierCalculation;
  "lib/treeSitter": typeof lib_treeSitter;
  "lib/utils": typeof lib_utils;
  "lib/waitlistEmail": typeof lib_waitlistEmail;
  "lib/workProviders/asana": typeof lib_workProviders_asana;
  "lib/workProviders/fetchWorkItem": typeof lib_workProviders_fetchWorkItem;
  "lib/workProviders/jira": typeof lib_workProviders_jira;
  "lib/workProviders/linear": typeof lib_workProviders_linear;
  "lib/workProviders/monday": typeof lib_workProviders_monday;
  "lib/workProviders/types": typeof lib_workProviders_types;
  "lib/workspaceIsolation": typeof lib_workspaceIsolation;
  mcpAuditLogs: typeof mcpAuditLogs;
  mcpRegistrationLimits: typeof mcpRegistrationLimits;
  notifications: typeof notifications;
  orchestrator: typeof orchestrator;
  payments: typeof payments;
  "pipelines/analyzeRequirements": typeof pipelines_analyzeRequirements;
  "pipelines/clarifyRequirements": typeof pipelines_clarifyRequirements;
  "pipelines/cleanupRepoData": typeof pipelines_cleanupRepoData;
  "pipelines/dispatchVerification": typeof pipelines_dispatchVerification;
  "pipelines/ensureDockerfile": typeof pipelines_ensureDockerfile;
  "pipelines/fetchGherkinUrl": typeof pipelines_fetchGherkinUrl;
  "pipelines/fetchRepo": typeof pipelines_fetchRepo;
  "pipelines/fetchWorkItem": typeof pipelines_fetchWorkItem;
  "pipelines/generateBDD": typeof pipelines_generateBDD;
  "pipelines/generateTDD": typeof pipelines_generateTDD;
  "pipelines/indexRepo": typeof pipelines_indexRepo;
  "pipelines/parseRepo": typeof pipelines_parseRepo;
  "pipelines/retrieveContext": typeof pipelines_retrieveContext;
  "pipelines/validateTests": typeof pipelines_validateTests;
  platformStats: typeof platformStats;
  pmConnections: typeof pmConnections;
  providerConnections: typeof providerConnections;
  repoConnections: typeof repoConnections;
  repoMaps: typeof repoMaps;
  sanityGates: typeof sanityGates;
  savedRepos: typeof savedRepos;
  seed: typeof seed;
  stripe: typeof stripe;
  stripeHandshakeChecks: typeof stripeHandshakeChecks;
  submissions: typeof submissions;
  testBounties: typeof testBounties;
  testSuites: typeof testSuites;
  users: typeof users;
  verificationArtifacts: typeof verificationArtifacts;
  verificationJobs: typeof verificationJobs;
  verificationReceipts: typeof verificationReceipts;
  verificationSteps: typeof verificationSteps;
  verifications: typeof verifications;
  waitlist: typeof waitlist;
  workerCallbackNonces: typeof workerCallbackNonces;
  workspaceCrashReports: typeof workspaceCrashReports;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
