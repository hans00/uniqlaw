// Turn an OpenAPI 3.0 components.schemas map into JSON Schema 2020-12 that ajv can enforce strictly:
//  • discriminator.mapping → base schema (S__base) + `if type=X then $ref X` dispatch, so the concrete
//    subtype (TextMessage, PostbackAction, UserSource, MessageEvent, …) is actually validated;
//  • subtypes' `allOf: [$ref S]` point at S__base (no infinite recursion);
//  • non-base object schemas get `unevaluatedProperties: false`, so unknown/misspelled fields fail.
type Schema = Record<string, any>;

export function toAjvSchemas(schemas: Record<string, Schema>, base: string): Record<string, Schema> {
  const polymorphic = new Set(Object.entries(schemas).filter(([, s]) => s.discriminator?.mapping).map(([n]) => n));
  const ref = (n: string) => `${base}#/$defs/${n}`;
  const rewrite = (v: any, inAllOfOf?: string): any => {
    if (Array.isArray(v)) return v.map((x) => rewrite(x, inAllOfOf));
    if (!v || typeof v !== "object") return v;
    const out: Schema = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "$ref" && typeof x === "string") {
        const n = x.replace("#/components/schemas/", "");
        out.$ref = ref(polymorphic.has(n) && inAllOfOf ? `${n}__base` : n);
      } else if (k === "allOf") out.allOf = (x as any[]).map((y) => rewrite(y, "1"));
      else if (k === "discriminator" || k === "externalDocs" || k === "example" || k === "x-") continue;
      else out[k] = rewrite(x);
    }
    if (out.nullable === true && out.type) { out.type = [out.type, "null"]; delete out.nullable; }
    return out;
  };
  const defs: Record<string, Schema> = {};
  for (const [n, s] of Object.entries(schemas)) {
    const body = rewrite(s);
    if (polymorphic.has(n)) {
      const prop = s.discriminator.propertyName as string;
      defs[`${n}__base`] = body;
      defs[n] = {
        allOf: [{ $ref: ref(`${n}__base`) },
          ...Object.entries(s.discriminator.mapping as Record<string, string>).map(([k, target]) => ({
            if: { properties: { [prop]: { const: k } }, required: [prop] },
            then: { $ref: ref(target.replace("#/components/schemas/", "")) },
          }))],
        unevaluatedProperties: false,
      };
    } else {
      const isObject = body.type === "object" || body.properties || body.allOf;
      defs[n] = isObject && body.additionalProperties === undefined && !s.additionalProperties ? { ...body, unevaluatedProperties: false } : body;
    }
  }
  return defs;
}
