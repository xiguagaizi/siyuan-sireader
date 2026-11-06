<template>
  <div class="handwriting-toolbar" role="toolbar" :aria-label="label('pdfHandwriting', '手写笔记')">
    <div class="handwriting-toolbar__tools">
      <button v-for="item in tools" :key="item.id" type="button" :aria-pressed="tool === item.id" :aria-label="item.label" :title="item.label" @click="$emit('tool', item.id)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.path" /></svg><span>{{ item.label }}</span>
      </button>
    </div>
    <label class="handwriting-toolbar__color" :title="label('pdfInkColor', '笔迹颜色')">
      <span>{{ label('pdfInkColor', '颜色') }}</span><input type="color" :value="color" :aria-label="label('pdfInkColor', '笔迹颜色')" @input="$emit('color', ($event.target as HTMLInputElement).value)">
    </label>
    <label class="handwriting-toolbar__width"><span>{{ label('pdfInkWidth', '粗细') }}</span>
      <select :value="width" :aria-label="label('pdfInkWidth', '笔迹粗细')" @change="$emit('width', Number(($event.target as HTMLSelectElement).value))">
        <option v-for="size in [1, 2, 3, 5]" :key="size" :value="size">{{ size }} pt</option>
      </select>
    </label>
    <label class="handwriting-toolbar__touch"><input type="checkbox" :checked="allowTouch" @change="$emit('touch', ($event.target as HTMLInputElement).checked)"><span>{{ label('pdfFingerWriting', '手指书写') }}</span></label>
    <button type="button" class="handwriting-toolbar__exit" :disabled="busy" @click="$emit('exit')">{{ busy ? label('saving', '保存中…') : label('pdfExitHandwriting', '退出手写') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { HandwritingTool } from '@/handwriting/session'
const props = defineProps<{ tool: HandwritingTool; color: string; width: number; allowTouch: boolean; busy: boolean; i18n?: any }>()
defineEmits<{ tool: [value: HandwritingTool]; color: [value: string]; width: [value: number]; touch: [value: boolean]; exit: [] }>()
const label = (key: string, fallback: string) => props.i18n?.[key] || fallback
const tools = computed(() => [
  { id: 'pen' as const, label: label('pdfHandwritingPen', '钢笔'), path: 'm16 3 5 5-12 12-6 1 1-6Z M14 5l5 5' },
  { id: 'highlighter' as const, label: label('pdfHandwritingHighlighter', '荧光笔'), path: 'm15 3 6 6-8 8-6-6Z M7 11l-3 6 3 3 6-3 M3 21h8' },
  { id: 'eraser' as const, label: label('pdfHandwritingEraser', '橡皮擦'), path: 'm15 3 6 6-12 12H6l-4-4Z M8 11l6 6 M9 21h12' },
])
</script>

<style scoped>
.handwriting-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 12px;background:var(--b3-theme-background,#fff);color:var(--b3-theme-on-background,#222);border-bottom:1px solid var(--b3-border-color,#ddd);flex:none;position:relative;z-index:2;box-sizing:border-box}
.handwriting-toolbar__tools{display:flex;gap:4px}
.handwriting-toolbar button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:8px 10px;border:0;border-radius:6px;font:inherit;color:inherit;background:transparent;cursor:pointer;touch-action:manipulation}
.handwriting-toolbar button:hover{background:var(--b3-theme-surface,#f3f3f3)}
.handwriting-toolbar button[aria-pressed=true]{background:var(--b3-theme-primary-lightest,#edf2ff);color:var(--b3-theme-primary,#315ac8)}
.handwriting-toolbar button:focus-visible,.handwriting-toolbar input:focus-visible,.handwriting-toolbar select:focus-visible{outline:2px solid var(--b3-theme-primary,#315ac8);outline-offset:2px}
.handwriting-toolbar svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
.handwriting-toolbar label{display:flex;align-items:center;gap:6px;min-height:44px;font-size:13px;white-space:nowrap}
.handwriting-toolbar input[type=color]{box-sizing:border-box;width:44px;height:44px;padding:8px;border:0;background:transparent;cursor:pointer}
.handwriting-toolbar select{min-height:44px;padding:4px 6px;border:1px solid var(--b3-border-color,#ddd);border-radius:6px;background:var(--b3-theme-background,#fff);color:inherit;font:inherit}
.handwriting-toolbar input[type=checkbox]{width:20px;height:20px;accent-color:var(--b3-theme-primary,#315ac8)}
.handwriting-toolbar__exit{margin-inline-start:auto}
.handwriting-toolbar button:disabled{opacity:.6;cursor:wait}
@media(max-width:600px){.handwriting-toolbar{gap:4px 8px;padding:4px 8px}.handwriting-toolbar__tools span{display:none}.handwriting-toolbar__color>span,.handwriting-toolbar__width>span{display:none}.handwriting-toolbar__touch{font-size:12px!important}}
</style>
