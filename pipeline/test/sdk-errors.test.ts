import { describe, it, expect } from "vitest";
import { SetupError, classifyPgError } from "../src/sdk/errors.js";

describe("classifyPgError", () => {
  it("maps 42601 to SQL_SYNTAX", () => {
    expect(classifyPgError("42601")).toBe(SetupError.SQL_SYNTAX);
  });

  it("maps 23503 to FK_VIOLATION", () => {
    expect(classifyPgError("23503")).toBe(SetupError.FK_VIOLATION);
  });

  it("maps 23505 to UNIQUE_VIOLATION", () => {
    expect(classifyPgError("23505")).toBe(SetupError.UNIQUE_VIOLATION);
  });

  it("maps 42703 to COLUMN_NOT_FOUND", () => {
    expect(classifyPgError("42703")).toBe(SetupError.COLUMN_NOT_FOUND);
  });

  it("maps 42P01 to TABLE_NOT_FOUND", () => {
    expect(classifyPgError("42P01")).toBe(SetupError.TABLE_NOT_FOUND);
  });

  it("returns SQL_SYNTAX for unknown pg error codes", () => {
    expect(classifyPgError("99999")).toBe(SetupError.SQL_SYNTAX);
  });

  it("returns DB_CONNECTION for null/undefined code", () => {
    expect(classifyPgError(undefined)).toBe(SetupError.DB_CONNECTION);
  });
});
