/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { buildKiroPayload, dedupeByToolUseId, OpenAIChatRequest } from '../../../src/serverUtils'

// ── dedupeByToolUseId ─────────────────────────────────────────────────────────

describe('dedupeByToolUseId', function () {
    it('removes later entries that repeat a toolUseId', function () {
        const input = [
            { toolUseId: 'a', input: { x: 1 } },
            { toolUseId: 'b', input: { y: 2 } },
            { toolUseId: 'a', input: { x: 1 } },
        ]
        const out = dedupeByToolUseId(input)
        assert.strictEqual(out.length, 2)
        assert.deepStrictEqual(
            out.map((o) => o.toolUseId),
            ['a', 'b']
        )
    })

    it('keeps the first occurrence of each id', function () {
        const out = dedupeByToolUseId([
            { toolUseId: 'a', input: { first: true } },
            { toolUseId: 'a', input: { first: false } },
        ])
        assert.strictEqual(out.length, 1)
        assert.strictEqual(out[0].input.first, true)
    })

    it('leaves entries without an id untouched', function () {
        const out = dedupeByToolUseId([{ toolUseId: '' }, { toolUseId: '' }, {}])
        assert.strictEqual(out.length, 3)
    })

    it('returns an empty array for empty input', function () {
        assert.deepStrictEqual(dedupeByToolUseId([]), [])
    })
})

// ── buildKiroPayload tool-use deduplication ───────────────────────────────────

describe('buildKiroPayload tool-use dedup', function () {
    const tools = [
        {
            type: 'function' as const,
            function: { name: 'powershell', description: 'run', parameters: { type: 'object' } },
        },
    ]

    it('collapses duplicate toolUseIds in an assistant history turn', function () {
        // Reproduces the Bedrock error: "The toolUse blocks at messages.N.content
        // contain duplicate Ids". The same streamed tool call is present twice in
        // one assistant turn (e.g. session-store replay + client resend).
        const dupToolCall = {
            id: 'tooluse_9FFCuCnUmu6YDFMNUVM6g3',
            type: 'function',
            function: { name: 'powershell', arguments: '{"command":"Get-Date"}' },
        }
        const req: OpenAIChatRequest = {
            model: 'claude-sonnet-4.5',
            messages: [
                { role: 'user', content: 'run a tool call' },
                { role: 'assistant', content: 'sure', tool_calls: [dupToolCall] },
                { role: 'assistant', content: 'sure', tool_calls: [dupToolCall] },
                { role: 'tool', content: 'ok', tool_call_id: 'tooluse_9FFCuCnUmu6YDFMNUVM6g3' },
                { role: 'user', content: 'continue' },
            ],
            tools,
        } as any

        const payload = buildKiroPayload(req, 'conv-1')
        const history = payload.conversationState.history ?? []

        // Every assistantResponseMessage must have unique toolUse ids.
        for (const entry of history) {
            const toolUses = entry.assistantResponseMessage?.toolUses
            if (!toolUses) continue
            const ids = toolUses.map((t: any) => t.toolUseId)
            assert.strictEqual(new Set(ids).size, ids.length, `duplicate toolUseId in ${JSON.stringify(ids)}`)
        }
    })

    it('collapses duplicate toolResults on the current message', function () {
        const req: OpenAIChatRequest = {
            model: 'claude-sonnet-4.5',
            messages: [
                { role: 'user', content: 'go' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        { id: 'dup', type: 'function', function: { name: 'powershell', arguments: '{}' } },
                    ],
                },
                { role: 'tool', content: 'r1', tool_call_id: 'dup' },
                { role: 'tool', content: 'r1', tool_call_id: 'dup' },
            ],
            tools,
        } as any

        const payload = buildKiroPayload(req, 'conv-2')
        const ctx = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext
        if (ctx?.toolResults) {
            const ids = ctx.toolResults.map((t: any) => t.toolUseId)
            assert.strictEqual(new Set(ids).size, ids.length)
        }
    })
})
