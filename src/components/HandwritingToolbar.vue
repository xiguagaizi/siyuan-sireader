<template>
  <div ref="toolbar" class="handwriting-toolbar" role="toolbar" :aria-label="label('pdfHandwriting', '手写笔记')" @keydown.esc="closePanel(true)">
    <div class="handwriting-toolbar__tools">
      <button v-for="item in tools" :key="item.id" type="button" :aria-pressed="tool === item.id" :aria-label="item.label" :title="item.label" @click="$emit('tool', item.id)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.path" /></svg><span>{{ item.label }}</span>
      </button>
    </div>
    <div class="handwriting-toolbar__setting">
      <button ref="colorButton" type="button" class="handwriting-toolbar__field" aria-label="笔迹颜色" title="笔迹颜色" aria-haspopup="dialog" :aria-expanded="panel === 'color'" @click="togglePanel('color')"><i class="handwriting-toolbar__swatch" :style="{ background: color }"/><svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>
      <div v-if="panel === 'color'" class="handwriting-toolbar__popup handwriting-toolbar__palette" role="dialog" aria-label="笔迹颜色面板">
        <div class="handwriting-toolbar__presets"><button v-for="preset in presets" :key="preset.color" type="button" :aria-label="preset.name" :aria-pressed="color.toLowerCase() === preset.color" :style="{ background: preset.color }" @click="chooseColor(preset.color)"><svg v-if="color.toLowerCase() === preset.color" viewBox="0 0 24 24" :style="{ color: preset.color === '#facc15' ? '#222' : '#fff' }" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button></div>
        <div class="handwriting-toolbar__saturation" role="slider" aria-label="颜色饱和度" tabindex="0" :aria-valuenow="Math.round(saturation * 100)" aria-valuemin="0" aria-valuemax="100" :style="{ backgroundColor: `hsl(${hue} 100% 50%)` }" @pointerdown="pickSaturation" @pointermove="moveSaturation" @keydown="keySaturation"><i :style="{ left: `${saturation * 100}%`, top: `${(1 - value) * 100}%` }"/></div>
        <input class="handwriting-toolbar__hue" type="range" min="0" max="359" :value="hue" aria-label="色相" @input="hue = Number(($event.target as HTMLInputElement).value); emitHSV()">
        <div class="handwriting-toolbar__rgb"><label v-for="(channel, index) in ['R', 'G', 'B']" :key="channel">{{ channel }}<input type="number" min="0" max="255" :value="rgb[index]" :aria-label="channel" @change="changeRGB(index, $event)"></label></div>
        <label class="handwriting-toolbar__hex">HEX<input :value="color.toUpperCase()" aria-label="HEX" maxlength="7" @change="changeHex"></label>
      </div>
    </div>
    <div class="handwriting-toolbar__setting">
      <button ref="widthButton" type="button" class="handwriting-toolbar__field" aria-label="笔迹粗细" title="笔迹粗细" aria-haspopup="menu" :aria-expanded="panel === 'width'" @click="togglePanel('width')"><span class="handwriting-toolbar__line" :style="{ height: `${width}px` }"/><span>{{ width }} pt</span><svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
      <div v-if="panel === 'width'" class="handwriting-toolbar__popup handwriting-toolbar__widths" role="menu" aria-label="笔迹粗细选项" @keydown="navigateMenu">
        <button v-for="size in [1, 2, 3, 5]" :key="size" type="button" role="menuitemradio" :aria-checked="width === size" @click="$emit('width', size); closePanel(true)"><span class="handwriting-toolbar__line" :style="{ height: `${size}px` }"/><span>{{ size }} pt</span><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="width === size" d="m5 12 4 4L19 6"/></svg></button>
      </div>
    </div>
    <div class="handwriting-toolbar__history">
      <button type="button" aria-label="撤销" title="撤销" :disabled="!canUndo || busy" @click="$emit('undo')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5-5 5 5 5 M4 10h10a5 5 0 0 1 0 10h-3"/></svg></button>
      <button type="button" aria-label="重做" title="重做" :disabled="!canRedo || busy" @click="$emit('redo')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 5 5-5 5 M20 10H10a5 5 0 0 0 0 10h3"/></svg></button>
    </div>
    <label class="handwriting-toolbar__touch"><input type="checkbox" :checked="allowTouch" @change="$emit('touch', ($event.target as HTMLInputElement).checked)"><span>{{ label('pdfFingerWriting', '手指书写') }}</span></label>
    <div class="handwriting-toolbar__actions">
      <button type="button" :aria-label="fullscreen ? '退出全屏' : '全屏'" :title="fullscreen ? '退出全屏' : '全屏'" :aria-pressed="fullscreen" @click="$emit('fullscreen')"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="fullscreen ? 'M9 3v6H3 M15 3v6h6 M3 15h6v6 M21 15h-6v6' : 'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6'"/></svg></button>
      <button type="button" class="handwriting-toolbar__exit" :disabled="busy" :aria-label="label('pdfExitHandwriting', '退出手写')" :title="label('pdfExitHandwriting', '退出手写')" @click="$emit('exit')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5-7 7 7 7 M3 12h18"/></svg><span>{{ busy ? label('saving', '保存中…') : '返回' }}</span></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { HandwritingTool } from '@/handwriting/session'
const props = defineProps<{ tool: HandwritingTool; color: string; width: number; allowTouch: boolean; busy: boolean; canUndo: boolean; canRedo: boolean; fullscreen: boolean; i18n?: any }>()
const emit = defineEmits<{ tool: [value: HandwritingTool]; color: [value: string]; width: [value: number]; touch: [value: boolean]; exit: []; undo: []; redo: []; fullscreen: [] }>()
const label = (key: string, fallback: string) => props.i18n?.[key] || fallback
const toolbar = ref<HTMLElement>(), colorButton = ref<HTMLButtonElement>(), widthButton = ref<HTMLButtonElement>()
const panel = ref<'color' | 'width' | null>(null)
const presets = [{ name: '黑色', color: '#202124' }, { name: '蓝色', color: '#2563eb' }, { name: '红色', color: '#dc2626' }, { name: '黄色', color: '#facc15' }]
const rgb = computed(() => [1, 3, 5].map(i => parseInt(props.color.slice(i, i + 2), 16)))
const hue = ref(0), saturation = ref(0), value = ref(0)
watch(() => props.color, () => {
  const [r, g, b] = rgb.value.map(c => c / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  if (delta) hue.value = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360
  saturation.value = max ? delta / max : 0; value.value = max
}, { immediate: true })
const fromRGB = (values: number[]) => '#' + values.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')
const emitHSV = () => {
  const h = hue.value / 60, c = value.value * saturation.value, x = c * (1 - Math.abs(h % 2 - 1)), m = value.value - c
  const channels = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  emit('color', fromRGB(channels.map(c => (c + m) * 255)))
}
const closePanel = (restore = false) => { const current = panel.value; panel.value = null; if (restore) (current === 'color' ? colorButton : widthButton).value?.focus() }
const togglePanel = async (next: 'color' | 'width') => { panel.value = panel.value === next ? null : next; await nextTick(); if (panel.value === 'width') toolbar.value?.querySelector<HTMLElement>('[aria-checked=true]')?.focus() }
const chooseColor = (color: string) => { emit('color', color); closePanel(true) }
const changeRGB = (index: number, event: Event) => { const input = event.target as HTMLInputElement, number = Number(input.value); if (input.value === '' || !Number.isFinite(number)) { input.value = String(rgb.value[index]); return }; const channels = [...rgb.value]; channels[index] = Math.max(0, Math.min(255, number)); emit('color', fromRGB(channels)) }
const changeHex = (event: Event) => { const input = event.target as HTMLInputElement; if (/^#[0-9a-f]{6}$/i.test(input.value)) emit('color', input.value.toLowerCase()); else input.value = props.color }
const pickSaturation = (event: PointerEvent) => { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); moveSaturation(event, true) }
const moveSaturation = (event: PointerEvent, force = false) => { if (!force && !event.buttons) return; const box = (event.currentTarget as HTMLElement).getBoundingClientRect(); saturation.value = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)); value.value = 1 - Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)); emitHSV() }
const keySaturation = (event: KeyboardEvent) => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') saturation.value = Math.max(0, Math.min(1, saturation.value + (event.key === 'ArrowRight' ? .02 : -.02))); else value.value = Math.max(0, Math.min(1, value.value + (event.key === 'ArrowUp' ? .02 : -.02))); emitHSV() }
const navigateMenu = (event: KeyboardEvent) => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const items = Array.from(toolbar.value!.querySelectorAll<HTMLElement>('[role=menuitemradio]')); const i = items.indexOf(document.activeElement as HTMLElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
const outside = (event: PointerEvent) => { if (!event.composedPath().includes(toolbar.value!)) closePanel() }
onMounted(() => document.addEventListener('pointerdown', outside, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
const tools = computed(() => [
  { id: 'pen' as const, label: label('pdfHandwritingPen', '钢笔'), path: 'm16 3 5 5-12 12-6 1 1-6Z M14 5l5 5' },
  { id: 'highlighter' as const, label: label('pdfHandwritingHighlighter', '荧光笔'), path: 'm15 3 6 6-8 8-6-6Z M7 11l-3 6 3 3 6-3 M3 21h8' },
  { id: 'eraser' as const, label: label('pdfHandwritingEraser', '橡皮擦'), path: 'm15 3 6 6-12 12H6l-4-4Z M8 11l6 6 M9 21h12' },
])
</script>

<style scoped>
.handwriting-toolbar{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;padding:4px 8px;background:var(--b3-theme-background,#fff);color:var(--b3-theme-on-background,#222);border-bottom:1px solid var(--b3-border-color,#ddd);flex:none;position:relative;z-index:2;box-sizing:border-box;font-size:13px;line-height:1.2}
.handwriting-toolbar__tools,.handwriting-toolbar__history,.handwriting-toolbar__actions{display:flex;align-items:center;gap:2px}
.handwriting-toolbar__history{border-inline-start:1px solid var(--b3-border-color,#ddd);padding-inline-start:6px}
.handwriting-toolbar button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:36px;min-width:36px;padding:0 8px;border:1px solid transparent;border-radius:5px;font:inherit;color:inherit;background:transparent;cursor:pointer;touch-action:manipulation;white-space:nowrap}
.handwriting-toolbar button:hover{background:var(--b3-theme-surface,#f3f3f3)}
.handwriting-toolbar button[aria-pressed=true],.handwriting-toolbar button[aria-checked=true]{background:var(--b3-theme-primary-lightest,#edf2ff);color:var(--b3-theme-primary,#315ac8)}
.handwriting-toolbar button:focus-visible,.handwriting-toolbar input:focus-visible,.handwriting-toolbar [role=slider]:focus-visible{outline:2px solid var(--b3-theme-primary,#315ac8);outline-offset:2px}
.handwriting-toolbar svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
.handwriting-toolbar .chevron{width:14px;height:14px}
.handwriting-toolbar__setting{position:relative}
.handwriting-toolbar .handwriting-toolbar__field{border-color:var(--b3-border-color,#ddd);gap:7px}
.handwriting-toolbar__swatch{width:20px;height:20px;border-radius:3px;box-shadow:inset 0 0 0 1px #0003}
.handwriting-toolbar__line{display:inline-block;width:22px;background:currentColor;border-radius:3px;flex:none}
.handwriting-toolbar__touch{display:flex;align-items:center;justify-content:center;gap:5px;min-height:36px;white-space:nowrap;cursor:pointer}
.handwriting-toolbar input[type=checkbox]{width:17px;height:17px;margin:0;accent-color:var(--b3-theme-primary,#315ac8)}
.handwriting-toolbar button:disabled{opacity:.38;cursor:default}
.handwriting-toolbar__popup{position:absolute;top:calc(100% + 5px);left:50%;transform:translateX(-50%);background:var(--b3-theme-background,#fff);box-shadow:0 4px 18px #0003;padding:8px;border-radius:6px;z-index:20;box-sizing:border-box}
.handwriting-toolbar__palette{width:208px;display:flex;flex-direction:column;gap:8px}
.handwriting-toolbar__presets{display:flex;justify-content:space-between;gap:8px}
.handwriting-toolbar .handwriting-toolbar__presets button{width:36px;min-width:36px;height:32px;border:1px solid #0002}
.handwriting-toolbar__saturation{height:96px;position:relative;touch-action:none;background-image:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent);cursor:crosshair}
.handwriting-toolbar__saturation i{position:absolute;width:8px;height:8px;border:2px solid white;box-shadow:0 1px 3px #0009;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none}
.handwriting-toolbar__hue{width:100%;height:12px;margin:2px 0;appearance:none;border-radius:3px;background:linear-gradient(to right,red,#ff0,#0f0,#0ff,#00f,#f0f,red);cursor:pointer}
.handwriting-toolbar__hue::-webkit-slider-thumb{appearance:none;width:12px;height:16px;border:2px solid var(--b3-theme-on-background,#222);border-radius:3px;background:white}
.handwriting-toolbar__hue::-moz-range-thumb{width:10px;height:14px;border:2px solid var(--b3-theme-on-background,#222);border-radius:3px;background:white}
.handwriting-toolbar__rgb{display:flex;gap:6px}.handwriting-toolbar__rgb label{display:flex;align-items:center;gap:3px;font-size:11px;min-width:0}
.handwriting-toolbar__rgb input,.handwriting-toolbar__hex input{box-sizing:border-box;min-width:0;width:100%;height:26px;padding:2px 4px;border:1px solid var(--b3-border-color,#ddd);border-radius:3px;background:var(--b3-theme-background,#fff);color:inherit;font:inherit;font-variant-numeric:tabular-nums}
.handwriting-toolbar__hex{display:flex;align-items:center;gap:8px;font-size:11px}.handwriting-toolbar__hex input{flex:1}
.handwriting-toolbar__widths{width:132px;padding:4px}.handwriting-toolbar .handwriting-toolbar__widths button{width:100%;height:32px;justify-content:space-between;padding:0 7px}
@media(max-width:900px){.handwriting-toolbar__tools span{display:none}}
@media(max-width:480px){.handwriting-toolbar{gap:4px}.handwriting-toolbar button{padding:0 6px}.handwriting-toolbar__line{width:16px}.handwriting-toolbar__exit span{display:none}.handwriting-toolbar__touch{font-size:12px}.handwriting-toolbar__palette{left:0;transform:none}.handwriting-toolbar__history{padding-inline-start:3px}}
</style>
