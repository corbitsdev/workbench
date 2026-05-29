import { describe, expect, it } from "bun:test";
import { collateralItem, collateralVersion, painPoint, transcript, workbenchSession } from "./schema";

describe("database schema", () => {
  it("has transcript table", () => {
    expect(transcript).toBeDefined();
    expect(transcript.content).toBeDefined();
    expect(transcript.source).toBeDefined();
    expect(transcript.createdAt).toBeDefined();
  });

  it("has workbenchSession table", () => {
    expect(workbenchSession).toBeDefined();
    expect(workbenchSession.transcriptId).toBeDefined();
    expect(workbenchSession.status).toBeDefined();
    expect(workbenchSession.createdAt).toBeDefined();
    expect(workbenchSession.updatedAt).toBeDefined();
  });

  it("has painPoint table", () => {
    expect(painPoint).toBeDefined();
    expect(painPoint.sessionId).toBeDefined();
    expect(painPoint.severity).toBeDefined();
    expect(painPoint.context).toBeDefined();
    expect(painPoint.quote).toBeDefined();
    expect(painPoint.selected).toBeDefined();
    expect(painPoint.createdAt).toBeDefined();
  });

  it("has collateralItem table", () => {
    expect(collateralItem).toBeDefined();
    expect(collateralItem.painPointId).toBeDefined();
    expect(collateralItem.type).toBeDefined();
    expect(collateralItem.title).toBeDefined();
    expect(collateralItem.body).toBeDefined();
    expect(collateralItem.status).toBeDefined();
    expect(collateralItem.version).toBeDefined();
    expect(collateralItem.createdAt).toBeDefined();
    expect(collateralItem.updatedAt).toBeDefined();
  });

  it("has collateralVersion table", () => {
    expect(collateralVersion).toBeDefined();
    expect(collateralVersion.collateralId).toBeDefined();
    expect(collateralVersion.title).toBeDefined();
    expect(collateralVersion.body).toBeDefined();
    expect(collateralVersion.version).toBeDefined();
    expect(collateralVersion.createdAt).toBeDefined();
  });
});
