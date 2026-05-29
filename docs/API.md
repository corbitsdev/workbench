# GTM Workbench — API Documentation

This document describes the GTM Workbench API surface. For lower-level agent infrastructure and messaging details, see `interchange/docs/API.md`.

## Base URL

- **Development**: `http://localhost:4000`
- **Production**: TBD

## Authentication

Currently unauthenticated for prototype. Lightweight auth (demo gate or minimal) is planned for v1.

## Workflow API

The core API is a simple state machine: create a workflow, query its state, and advance it through steps.

### Create Workflow

```
POST /workflows
Content-Type: application/json

{
  "source": "paste" | "granola",
  "transcript": "...",          // Required if source="paste"
  "granolaId": "..."            // Required if source="granola"
}
```

**Response** (201 Created):

```json
{
  "id": "uuid",
  "status": "analyzing",
  "steps": {
    "intake": { "completed": true, "transcriptId": "uuid" }
  }
}
```

**Status codes:**

- `201`: Workflow created successfully
- `400`: Invalid source or missing required fields
- `413`: Transcript exceeds maximum length (500KB)
- `503`: Granola API not configured

---

### Get Workflow

```
GET /workflows/:id
```

**Response** (200 OK):

```json
{
  "id": "uuid",
  "status": "reviewing",
  "currentStep": "generate",
  "steps": {
    "intake": {
      "completed": true,
      "transcriptId": "uuid",
      "transcript": "..."
    },
    "analyze": {
      "completed": true,
      "painPoints": [
        {
          "id": "uuid",
          "workflowId": "uuid",
          "severity": "high",
          "context": "Customer mentioned slow approval process",
          "quote": "Takes 3 weeks to get approvals",
          "selected": true,
          "createdAt": "2026-05-28T10:00:00Z"
        }
      ]
    },
    "generate": {
      "completed": false,
      "collateral": []
    },
    "improve": { "completed": false },
    "export": { "completed": false }
  }
}
```

**Fields:**

- `currentStep`: Derived from `status`. Maps to step name: `intake`, `analyze`, `generate`, `improve`, `export`
- `status`: Internal state value (see Status Mapping below)
- `steps`: Keyed by step name. Each step has:
  - `completed`: boolean
  - Step-specific payload (painPoints, collateral, etc.)

**Status codes:**

- `200`: Success
- `404`: Workflow not found

---

### Run Step

```
POST /workflows/:id/steps
Content-Type: application/json

{
  "step": "analyze" | "generate" | "improve" | "export",
  "painPointIds": ["uuid", ...],        // Required for generate
  "collateralId": "uuid",               // Required for improve
  "feedback": "..."                     // Optional for analyze; required for improve
}
```

**Response** (200 OK):

```json
{
  "id": "uuid",
  "status": "reviewing",
  "currentStep": "generate",
  "steps": { ... }  // Updated state after step completed
}
```

**Step Behaviors:**

#### Analyze

- Extracts pain points from the transcript
- Accepts optional `feedback` to refine the LLM prompt
- **Feedback example**: "Focus on automation pain" → LLM prioritizes pain points related to automation
- Returns updated `steps.analyze.painPoints` array
- Sets workflow status to `reviewing`

#### Generate

- Requires array of pain point IDs (`painPointIds`)
- Creates collateral items (email, LinkedIn, one-pager, battlecard) for each selected pain point
- Returns updated `steps.generate.collateral` array
- Sets workflow status to `generating`

#### Improve

- Requires specific collateral ID and feedback text
- Applies feedback to refine the collateral (e.g., "make it shorter", "more executive tone")
- Archives previous version in `collateral_version` table
- Returns updated collateral with new version
- If no more collateral to improve, moves workflow to `exporting`

#### Export

- Not yet implemented (returns 501)

**Error responses:**

- `400`: Invalid step or missing required parameters
- `404`: Workflow or resource not found
- `501`: Step not implemented

---

## Recent Calls API

```
GET /recent-calls
```

Fetches recent calls from Granola API (if configured).

**Response** (200 OK):

```json
{
  "calls": [
    {
      "id": "...",
      "title": "...",
      "date": "...",
      "transcript": "..."
    }
  ]
}
```

**Status codes:**

- `200`: Success
- `503`: Granola API not configured

---

## Health Check

```
GET /health
```

**Response** (200 OK):

```json
{
  "status": "ok",
  "service": "GTM Workbench"
}
```

---

## Status Mapping

Internal `status` values map to frontend `currentStep`:

| Status     | Current Step | Meaning                            |
| ---------- | ------------ | ---------------------------------- |
| analyzing  | analyze      | Extracting pain points             |
| reviewing  | generate     | User selecting pain points         |
| generating | generate     | Generating collateral              |
| improving  | improve      | User improving selected collateral |
| exporting  | export       | Assembling final output            |
| done       | export       | Workflow complete                  |

Mapping is defined in `apps/api/src/routes/workflow.ts:deriveCurrentStep()`.

---

## Data Types

### Pain Point

```typescript
{
  id: string; // UUID
  workflowId: string; // UUID (same as sessionId)
  severity: 'low' | 'medium' | 'high' | 'critical';
  context: string; // Summary of the pain
  quote: string; // Exact customer words
  selected: boolean; // User-selected for collateral generation
  createdAt: string; // ISO 8601 timestamp
}
```

### Collateral Item

```typescript
{
  id: string; // UUID
  painPointId: string; // UUID
  type: 'email' | 'linkedin' | 'one-pager' | 'battlecard';
  title: string;
  body: string;
  status: 'draft' | 'approved' | 'rejected';
  version: number; // Incremented on feedback
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
}
```

---

## Feedback Flow

### Analysis Feedback

User provides feedback in the **Live Analysis** stage to refine pain point extraction:

1. User types feedback in LiveAnalysisReview textarea (e.g., "Focus on automation")
2. Frontend calls `POST /workflows/:id/steps` with:
   ```json
   {
     "step": "analyze",
     "feedback": "Focus on automation"
   }
   ```
3. API extracts pain points again, conditioning the LLM prompt on the feedback
4. Frontend fetches updated workflow state and re-renders the pain point list
5. User can refine further or proceed to select pain points

### Improvement Feedback

User provides feedback during the **Improvement** stage to refine collateral:

1. User types feedback in CollateralImprovement textarea for each approved item (e.g., "shorter version")
2. Frontend calls `POST /workflows/:id/steps` for each item with:
   ```json
   {
     "step": "improve",
     "collateralId": "uuid",
     "feedback": "shorter version"
   }
   ```
3. API applies feedback heuristics (keywords like "shorter", "punch", "hook")
4. Previous version is archived; new version is saved
5. Frontend fetches updated workflow and moves to Final Export

---

## Error Handling

All endpoints return errors in this format:

```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:

| Code | Meaning                          |
| ---- | -------------------------------- |
| 200  | Success                          |
| 201  | Created                          |
| 400  | Bad request (invalid payload)    |
| 404  | Resource not found               |
| 413  | Payload too large                |
| 500  | Server error                     |
| 501  | Feature not implemented          |
| 503  | Service unavailable (e.g., APIs) |
