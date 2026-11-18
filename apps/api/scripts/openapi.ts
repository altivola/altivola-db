// Writes openapi.json from the oRPC router. CI fails when the committed file is out of date.
import { writeFile } from 'node:fs/promises'
import { router } from '@app/api'
import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { openapiInfo, tokenHeader } from '../src/app.ts'

const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
const spec = await generator.generate(router, {
  info: openapiInfo,
  servers: [{ url: '/api' }],
  components: { securitySchemes: { token: { type: 'apiKey', in: 'header', name: tokenHeader } } },
  security: [{ token: [] }],
})

const file = new URL('../openapi.json', import.meta.url)
await writeFile(file, `${JSON.stringify(spec, null, 2)}\n`)
console.info(`wrote ${file.pathname}`)
