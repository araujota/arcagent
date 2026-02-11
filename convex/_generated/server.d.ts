/* eslint-disable */
/**
 * Generated server types — stub file.
 * This file will be replaced when running `convex dev`.
 */
import type {
  GenericQueryCtx,
  GenericMutationCtx,
  GenericActionCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  FunctionReference,
} from "convex/server";
import type { DataModel } from "./dataModel";

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;

export declare const query: any;
export declare const internalQuery: any;
export declare const mutation: any;
export declare const internalMutation: any;
export declare const action: any;
export declare const internalAction: any;
export declare const httpAction: any;
export declare const httpRouter: any;
