import { describe, expect, it } from "bun:test"
import { type } from "arktype"
import { createClient } from "../src/runtime/index.js"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

describe("createClient", () => {
  it("loads a 3.1 spec and builds schemas", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    expect(client.api.title).toBe("Petstore")
    expect(client.api.version).toBe("1.0.0")
    expect(client.api.servers).toEqual([
      { url: "https://petstore.example.com/v1", description: "Production" },
    ])

    // Component schemas are available
    expect(client.schemas.Pet).toBeDefined()
    expect(client.schemas.NewPet).toBeDefined()
    expect(client.schemas.Error).toBeDefined()
    expect(client.schemas.Status).toBeDefined()
  })

  it("validates data against component schemas", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    const validPet = { id: 1, name: "Fido" }
    expect(client.schemas.Pet(validPet)).toEqual(validPet)

    const invalidPet = { id: "not-a-number", name: "Fido" }
    expect(client.schemas.Pet(invalidPet) instanceof type.errors).toBe(true)

    // Missing required field
    expect(client.schemas.Pet({ name: "Fido" }) instanceof type.errors).toBe(
      true
    )

    // Optional fields work
    const withTag = { id: 1, name: "Fido", tag: "dog" }
    expect(client.schemas.Pet(withTag)).toEqual(withTag)
  })

  it("validates enum schema", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    expect(client.schemas.Status("available")).toBe("available")
    expect(client.schemas.Status("pending")).toBe("pending")
    expect(
      client.schemas.Status("invalid") instanceof type.errors
    ).toBe(true)
  })

  it("builds operation validators", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    const listPets = client.operation("get", "/pets")
    expect(listPets).toBeDefined()
    expect(listPets!.queryParams).toBeDefined()
    expect(listPets!.responses["200"]).toBeDefined()
    expect(listPets!.responses["200"]["application/json"]).toBeDefined()

    // Validate a list response
    const validResponse = [{ id: 1, name: "Fido" }]
    const responseValidator = listPets!.responses["200"]["application/json"]
    expect(responseValidator(validResponse)).toEqual(validResponse)
  })

  it("includes path-level parameters in operations", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    const showPet = client.operation("get", "/pets/{petId}")
    expect(showPet).toBeDefined()
    expect(showPet!.pathParams).toBeDefined()

    // petId is a required path param
    expect(showPet!.pathParams!({ petId: "123" })).toEqual({ petId: "123" })
    expect(
      showPet!.pathParams!({}) instanceof type.errors
    ).toBe(true)
  })

  it("handles requestBody validators", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    const createPet = client.operation("post", "/pets")
    expect(createPet).toBeDefined()
    expect(createPet!.requestBody).toBeDefined()
    expect(createPet!.requestBody!["application/json"]).toBeDefined()

    const bodyValidator = createPet!.requestBody!["application/json"]
    expect(bodyValidator({ name: "Fido" })).toEqual({ name: "Fido" })
    expect(bodyValidator({}) instanceof type.errors).toBe(true)
  })

  it("returns undefined for nonexistent operations", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    expect(client.operation("delete", "/pets")).toBeUndefined()
    expect(client.operation("get", "/nonexistent")).toBeUndefined()
  })

  it("exposes the navigable API description", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    expect(Object.keys(client.api.paths)).toContain("/pets")
    expect(Object.keys(client.api.paths)).toContain("/pets/{petId}")

    const petsPath = client.api.paths["/pets"]
    expect(petsPath.operations.get).toBeDefined()
    expect(petsPath.operations.get!.operationId).toBe("listPets")
    expect(petsPath.operations.get!.tags).toEqual(["pets"])
    expect(petsPath.operations.post).toBeDefined()
    expect(petsPath.operations.post!.operationId).toBe("createPet")
  })

  it("loads a 3.0 spec with backward compatibility", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.0.json"),
    })

    expect(client.schemas.Pet).toBeDefined()
    const valid = { id: 1, name: "Rex" }
    expect(client.schemas.Pet(valid)).toEqual(valid)
  })

  it("loads a spec from an inline object", async () => {
    const spec = JSON.parse(
      readFileSync(join(fixturesDir, "petstore-3.1.json"), "utf-8")
    )
    const client = await createClient({ spec })
    expect(client.api.title).toBe("Petstore")
    expect(client.schemas.Pet).toBeDefined()
  })

  it("loads a spec from an inline JSON string", async () => {
    const specStr = readFileSync(
      join(fixturesDir, "petstore-3.1.json"),
      "utf-8"
    )
    const client = await createClient({ spec: specStr })
    expect(client.api.title).toBe("Petstore")
  })

  it("applies format validation on schemas", async () => {
    const client = await createClient({
      path: join(fixturesDir, "petstore-3.1.json"),
    })

    // Pet has an email field with format: email
    const withValidEmail = { id: 1, name: "Fido", email: "fido@pets.com" }
    expect(client.schemas.Pet(withValidEmail)).toEqual(withValidEmail)

    const withInvalidEmail = { id: 1, name: "Fido", email: "not-an-email" }
    expect(
      client.schemas.Pet(withInvalidEmail) instanceof type.errors
    ).toBe(true)
  })
})
