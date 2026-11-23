<template>
  <div class="house-editor" :class="{ 'is-phone': phone }">
    <div class="house-editor__main">
      <!-- Rounded, here only: the controls floating over the blueprint. -->
      <div class="house-editor__toolbar" data-nb-appearance="rounded">
        <!-- One icon per tool, named by its tooltip (which is also its accessible name). -->
        <div class="house-editor__tools" role="toolbar" aria-label="Drawing tool">
          <NbButton
            v-for="t in TOOLS"
            :key="t.id"
            v-nb-tooltip="{ body: t.label, position: 'bottom' }"
            size="sm"
            :variant="tool === t.id ? 'primary' : 'ghost'"
            :icon="t.icon"
            :aria-pressed="tool === t.id"
            @click="setTool(t.id)"
          />
        </div>
        <div class="house-editor__tools" role="group" aria-label="History">
          <NbButton
            v-nb-tooltip="{ body: `Undo (${mod} Z)`, position: 'bottom', aria: 'none' }"
            size="sm"
            variant="ghost"
            icon="arrow-u-up-left"
            aria-label="Undo"
            :disabled="!canUndo"
            @click="undo"
          />
          <NbButton
            v-nb-tooltip="{ body: `Redo (${mod} Shift Z)`, position: 'bottom', aria: 'none' }"
            size="sm"
            variant="ghost"
            icon="arrow-u-up-right"
            aria-label="Redo"
            :disabled="!canRedo"
            @click="redo"
          />
        </div>
        <NbButton
          v-if="!phone && !(inspector.visible && inspector.mode === 'house-editor')"
          size="sm"
          variant="secondary"
          icon="sidebar-simple"
          @click="inspector.openHouseEditor()"
        >
          Details
        </NbButton>
      </div>

      <div
        ref="canvasEl"
        class="house-editor__canvas hv-stage-bg"
        :style="phone ? { aspectRatio: phoneAspect } : undefined"
      >
        <svg
          ref="svgEl"
          class="house-editor__svg"
          :class="[`hv-tool-${tool}`, { 'is-panning': spaceHeld || panning }]"
          :style="{ '--hv-zoom': zoom }"
          :viewBox="viewBox"
          role="application"
          aria-label="Blueprint editor"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
          @pointerleave="cursor = null"
          @wheel="onWheel"
          v-html="markup"
        />
        <!-- Rulers in metres along the top and the left, measuring from the plot's corner. -->
        <HouseRuler
          class="house-editor__ruler house-editor__ruler--x"
          axis="x"
          :px-per-m="view.pxPerM"
          :origin="view.ox - RULER_SIZE"
          :length="Math.max(0, view.w - RULER_SIZE)"
          :cursor="cursor ? cursor[0] - RULER_SIZE : null"
        />
        <HouseRuler
          class="house-editor__ruler house-editor__ruler--y"
          axis="y"
          :px-per-m="view.pxPerM"
          :origin="view.oy - RULER_SIZE"
          :length="Math.max(0, view.h - RULER_SIZE)"
          :cursor="cursor ? cursor[1] - RULER_SIZE : null"
        />
        <div class="house-editor__ruler-corner" aria-hidden="true">m</div>
        <HouseFloorMenu
          class="house-editor__floors"
          :floors="plan.floors"
          :model-value="floorId"
          :phone="phone"
          editable
          @update:model-value="selectFloor"
          @add="newFloor"
          @rename="renameFloor"
          @delete="deleteFloor"
        />
        <div class="house-editor__zoom" role="group" aria-label="Zoom" data-nb-appearance="rounded">
          <NbButton
            v-nb-tooltip="{ body: `Zoom in (${mod} +, or ${mod} and scroll)`, position: 'left', aria: 'none' }"
            size="sm"
            variant="ghost"
            icon="magnifying-glass-plus"
            aria-label="Zoom in"
            :disabled="zoom >= MAX_ZOOM"
            @click="zoomBy(1.4)"
          />
          <NbButton
            v-nb-tooltip="{ body: `Zoom out (${mod} −)`, position: 'left', aria: 'none' }"
            size="sm"
            variant="ghost"
            icon="magnifying-glass-minus"
            aria-label="Zoom out"
            :disabled="zoom <= MIN_ZOOM"
            @click="zoomBy(1 / 1.4)"
          />
          <NbButton
            v-nb-tooltip="{ body: `Fit the plot (${mod} 0)`, position: 'left', aria: 'none' }"
            size="sm"
            variant="ghost"
            icon="frame-corners"
            aria-label="Fit the plot"
            :disabled="zoom === 1 && !center"
            @click="resetView"
          />
          <span class="house-editor__zoom-level" aria-live="polite">{{ Math.round(zoom * 100) }}%</span>
        </div>
      </div>
      <div class="house-editor__help" data-nb-appearance="rounded">
        <NbMessage variant="helper">{{ help }}</NbMessage>
      </div>
    </div>

    <!-- What is selected, and the devices not on the plan yet. On a wide
         screen they live in the shell's inspector beside the blueprint. On a
         phone the inspector is a sheet that would cover the blueprint, so
         they stay under it. -->
    <Teleport defer to="#house-editor-inspector" :disabled="phone">
      <aside class="house-editor__side">
        <!-- The floor being edited, in 3D, redrawn as you draw. On a phone the
             blueprint above is all the room there is. -->
        <div v-if="!phone" class="house-editor__preview">
          <HouseStage
            preview
            fill
            :plan="previewPlan"
            :devices="devices"
            :floor="floorId"
            mode="iso"
            walls="up"
            overlay="none"
            :labels="false"
            :selected="null"
          />
        </div>
        <NbTabs v-model="sideTab" :items="SIDE_TABS" size="sm" full-width aria-label="Editor panels">
          <template #properties>
            <!-- What is selected -->
            <NbPanel v-if="room" title="Room" :flat="true">
              <NbField v-slot="{ id }" label="Name" orientation="stack">
                <NbTextInput :id="id" v-model="room.name" size="sm" :maxlength="80" />
              </NbField>
              <NbField v-slot="{ id }" label="Type" orientation="stack">
                <NbSelect :id="id" v-model="room.kind" :options="ROOM_KINDS" size="sm" />
              </NbField>
              <p class="house-editor__muted">
                {{
                  room.parts?.length
                    ? `${metres(roomArea(room) / CELLS_PER_M)} m², in ${room.parts.length + 1} parts`
                    : `${metres(room.w)} × ${metres(room.h)} m`
                }}
              </p>
              <!-- A wing is another rectangle joined to the room along an edge: an L
             is one wing, a U two. -->
              <div v-for="(part, i) in room.parts ?? []" :key="i" class="house-editor__row house-editor__row--tight">
                <span>Wing {{ i + 1 }} · {{ metres(part.w) }} × {{ metres(part.h) }} m</span>
                <NbButton
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  :aria-label="`Remove wing ${i + 1}`"
                  @click="removeWing(i)"
                />
              </div>
              <div class="house-editor__row">
                <NbButton
                  size="sm"
                  :variant="wingFor === room.id ? 'primary' : 'secondary'"
                  :aria-pressed="wingFor === room.id"
                  @click="toggleWing"
                >
                  {{ wingFor === room.id ? 'Drawing a wing' : 'Add a wing' }}
                </NbButton>
                <NbButton size="sm" variant="danger" icon="trash" @click="deleteRoom">Delete room</NbButton>
              </div>
            </NbPanel>

            <template v-else-if="opening">
              <NbPanel :title="openingName(opening)" :flat="true">
                <NbField v-slot="{ id }" label="What it is" orientation="stack">
                  <NbSelect
                    :id="id"
                    :model-value="opening.type === 'open' ? 'open' : opening.type === 'window' ? 'window' : 'door'"
                    :options="OPENING_KINDS"
                    size="sm"
                    @update:model-value="(v) => setOpeningKind(opening!, v as 'door' | 'window' | 'open')"
                  />
                </NbField>
                <NbField v-if="openingSpec" v-slot="{ id }" label="Preset" orientation="stack">
                  <NbSelect
                    :id="id"
                    :model-value="presetOf(opening)?.id ?? ''"
                    :options="presetOptions"
                    size="sm"
                    @update:model-value="(v) => pickPreset(String(v ?? ''))"
                  />
                </NbField>
                <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
                  <NbNumberInput
                    :id="id"
                    :model-value="opening.len / CELLS_PER_M"
                    :min="0.5"
                    :max="20"
                    :step="0.25"
                    size="sm"
                    @update:model-value="setOpeningLength"
                  />
                </NbField>
                <template v-if="openingSpec">
                  <NbField v-slot="{ id }" label="How it opens" orientation="stack">
                    <NbSelect
                      :id="id"
                      :model-value="openingSpec.operation"
                      :options="operationOptions"
                      size="sm"
                      @update:model-value="(v) => setOperation(opening!, String(v))"
                    />
                  </NbField>
                  <NbField v-if="openingSpec.kind === 'door'" v-slot="{ id }" label="Leaf" orientation="stack">
                    <NbSelect
                      :id="id"
                      :model-value="openingSpec.leaf"
                      :options="leafOptions"
                      size="sm"
                      @update:model-value="(v) => setLeaf(opening!, v as 'solid' | 'glazed' | 'part-glazed')"
                    />
                  </NbField>
                  <div class="house-editor__pair">
                    <NbField v-slot="{ id }" label="Frame" orientation="stack">
                      <NbSelect
                        :id="id"
                        :model-value="openingSpec.frame?.material ?? ''"
                        :options="FRAME_OPTIONS"
                        size="sm"
                        @update:model-value="(v) => setFrame('material', String(v ?? ''))"
                      />
                    </NbField>
                    <NbField v-slot="{ id }" label="Colour" orientation="stack">
                      <NbSelect
                        :id="id"
                        :model-value="openingSpec.frame?.colour ?? ''"
                        :options="COLOUR_OPTIONS"
                        size="sm"
                        @update:model-value="(v) => setFrame('colour', String(v ?? ''))"
                      />
                    </NbField>
                  </div>
                  <!-- A door stands on the floor, so only a window has a sill. -->
                  <div class="house-editor__pair">
                    <NbField v-if="openingSpec.kind === 'window'" v-slot="{ id }" label="Sill (m)" orientation="stack">
                      <NbNumberInput
                        :id="id"
                        :model-value="openingSpec.sill / 1000"
                        :min="0"
                        :max="3"
                        :step="0.05"
                        size="sm"
                        @update:model-value="(v: number | null) => setHeight('sill', v)"
                      />
                    </NbField>
                    <NbField v-slot="{ id }" label="Head (m)" orientation="stack">
                      <NbNumberInput
                        :id="id"
                        :model-value="openingSpec.head / 1000"
                        :min="0.3"
                        :max="4"
                        :step="0.05"
                        size="sm"
                        @update:model-value="(v: number | null) => setHeight('head', v)"
                      />
                    </NbField>
                  </div>
                  <template v-if="opening.type === 'door'">
                    <p class="house-editor__muted">{{ doorText }}</p>
                    <div class="house-editor__row house-editor__row--tight">
                      <NbButton size="sm" variant="secondary" icon="arrows-left-right" @click="flipHinge">
                        Flip hinge
                      </NbButton>
                      <NbButton size="sm" variant="secondary" icon="arrows-down-up" @click="flipSide">
                        Open other way
                      </NbButton>
                    </div>
                  </template>
                </template>
                <p v-if="opening.type === 'open'" class="house-editor__muted">
                  No wall is drawn here, so the two rooms run into each other. Drag an end to leave part of the wall
                  standing.
                </p>
                <p class="house-editor__muted">Drag it along the wall to move it, or drag an end to resize it.</p>
                <div class="house-editor__row">
                  <span />
                  <NbButton size="sm" variant="danger" icon="trash" @click="deleteOpening">Remove</NbButton>
                </div>
              </NbPanel>

              <NbPanel v-if="glazed" title="Coverings" :flat="true">
                <p v-if="!coverings.length" class="house-editor__muted">
                  Nothing covers this glass yet. Add a shutter, a blind or curtains, and say what drives each one.
                </p>
                <div v-for="c in coverings" :key="c.id" class="house-editor__covering">
                  <div class="house-editor__pair">
                    <NbField v-slot="{ id }" label="Covering" orientation="stack">
                      <NbSelect :id="id" v-model="c.kind" :options="COVERING_OPTIONS" size="sm" />
                    </NbField>
                    <NbField v-slot="{ id }" label="Side" orientation="stack">
                      <NbSelect :id="id" v-model="c.side" :options="SIDE_OPTIONS" size="sm" />
                    </NbField>
                  </div>
                  <div class="house-editor__row house-editor__row--tight house-editor__row--end">
                    <NbField v-slot="{ id }" label="Driven by" orientation="stack" class="house-editor__grow">
                      <NbSelect
                        :id="id"
                        :model-value="driverOf(floor, opening, c.id)?.ref ?? ''"
                        :options="driverOptions(c.id)"
                        size="sm"
                        @update:model-value="(v) => setDriver(c.id, String(v ?? ''))"
                      />
                    </NbField>
                    <NbButton
                      v-nb-tooltip="{ body: 'Remove this covering', position: 'left' }"
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label="Remove this covering"
                      @click="removeCovering(floor, opening, c.id)"
                    />
                  </div>
                </div>
                <div class="house-editor__row">
                  <span />
                  <NbButton size="sm" variant="secondary" icon="plus" @click="addNextCovering">Add a covering</NbButton>
                </div>
              </NbPanel>
            </template>

            <NbPanel v-else-if="radiator" title="Radiator" :flat="true">
              <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
                <NbNumberInput
                  :id="id"
                  :model-value="radiator.len / CELLS_PER_M"
                  :min="0.5"
                  :max="5"
                  :step="0.25"
                  size="sm"
                  @update:model-value="setRadiatorLength"
                />
              </NbField>
              <p class="house-editor__muted">{{ radiatorText }}</p>
              <div class="house-editor__row house-editor__row--tight">
                <NbButton size="sm" variant="secondary" icon="arrows-down-up" @click="flipRadiator">
                  Other side of the wall
                </NbButton>
              </div>
              <p class="house-editor__muted">Drag it along the wall to move it, or drag an end to resize it.</p>
              <div class="house-editor__row">
                <span />
                <NbButton size="sm" variant="danger" icon="trash" @click="deleteRadiator">Remove</NbButton>
              </div>
            </NbPanel>

            <NbPanel v-else-if="piece" :title="FURNITURE_NAME[piece.kind]" :flat="true">
              <NbField v-slot="{ id }" label="Type" orientation="stack">
                <NbSelect :id="id" v-model="piece.kind" :options="FURNITURE_KINDS" size="sm" />
              </NbField>
              <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
                <NbNumberInput
                  :id="id"
                  :model-value="piece.w / CELLS_PER_M"
                  :min="0.25"
                  :max="20"
                  :step="0.25"
                  size="sm"
                  @update:model-value="(v: number | null) => setPieceSize('w', v)"
                />
              </NbField>
              <NbField v-slot="{ id }" label="Depth (m)" orientation="stack">
                <NbNumberInput
                  :id="id"
                  :model-value="piece.d / CELLS_PER_M"
                  :min="0.25"
                  :max="20"
                  :step="0.25"
                  size="sm"
                  @update:model-value="(v: number | null) => setPieceSize('d', v)"
                />
              </NbField>
              <NbField v-if="piece.kind !== 'rug'" v-slot="{ id }" label="Height (m)" orientation="stack">
                <NbNumberInput
                  :id="id"
                  :model-value="furnitureHeight(piece)"
                  :min="0.1"
                  :max="3"
                  :step="0.05"
                  size="sm"
                  @update:model-value="setPieceHeight"
                />
              </NbField>
              <p class="house-editor__muted">{{ pieceText }}</p>
              <div v-if="FURNITURE_BACK[piece.kind]" class="house-editor__row house-editor__row--tight">
                <NbButton size="sm" variant="secondary" icon="arrows-down-up" @click="flipPiece">
                  {{
                    piece.kind === 'bed' || piece.kind === 'lounger'
                      ? 'Head at the other end'
                      : 'Back to the other side'
                  }}
                </NbButton>
              </div>
              <div class="house-editor__row">
                <NbButton size="sm" variant="secondary" icon="arrow-clockwise" @click="turnPiece">Turn</NbButton>
                <NbButton size="sm" variant="danger" icon="trash" @click="deletePiece">Remove</NbButton>
              </div>
            </NbPanel>

            <NbPanel v-else-if="placed" :title="placedDevice?.name ?? 'Device'" :flat="true">
              <p v-if="!placedDevice" class="house-editor__muted">
                This device is no longer on the bridge. Remove it from the plan, or leave it in case its plugin comes
                back.
              </p>
              <p v-else-if="placedDevice.kind === 'shutter'" class="house-editor__muted">
                {{ placedDriveText }}
              </p>
              <NbField v-if="placedDevice?.kind === 'light'" v-slot="{ id }" label="Mounted" orientation="stack">
                <NbSelect
                  :id="id"
                  :model-value="lightMount(floor, placed)"
                  :options="LIGHT_MOUNTS"
                  size="sm"
                  @update:model-value="(v: unknown) => setMount(v as HouseLightMount)"
                />
              </NbField>
              <template v-if="placedDevice && takesLook(placedDevice)">
                <NbField
                  v-slot="{ id }"
                  label="Drawn as"
                  hint="The bridge sees a plug or a relay. Say what it powers, and the plan draws that."
                  orientation="stack"
                >
                  <NbSelect
                    :id="id"
                    :model-value="placed.look ?? ''"
                    :options="lookOptions"
                    size="sm"
                    @update:model-value="(v: unknown) => setLook(v ? (v as HouseLook) : null)"
                  />
                </NbField>
                <NbField
                  v-if="(placed.look ?? placedDevice.defaultLook) === 'tv'"
                  v-slot="{ id }"
                  label="Screen runs"
                  orientation="stack"
                >
                  <NbSelect
                    :id="id"
                    :model-value="placed.axis ?? 'h'"
                    :options="GATE_AXES"
                    size="sm"
                    @update:model-value="(v: unknown) => setGateAxis(v === 'v' ? 'v' : 'h')"
                  />
                </NbField>
              </template>
              <NbField
                v-if="placedDevice?.kind === 'light' && !placedDevice.color"
                v-slot="{ id }"
                label="Glow colour"
                hint="This light cannot report a colour, so the plan uses this one."
                orientation="stack"
              >
                <NbSelect
                  :id="id"
                  :model-value="placed.color ?? WARM_LIGHT"
                  :options="GLOW_COLOURS"
                  size="sm"
                  @update:model-value="(v: unknown) => setColor(String(v))"
                />
              </NbField>
              <template v-if="placedDevice?.kind === 'gate'">
                <NbField v-slot="{ id }" label="Gate width (m)" orientation="stack">
                  <NbNumberInput
                    :id="id"
                    :model-value="(placed.length ?? 4) / CELLS_PER_M"
                    :min="0.5"
                    :max="20"
                    :step="0.5"
                    size="sm"
                    @update:model-value="setGateLength"
                  />
                </NbField>
                <NbField v-slot="{ id }" label="Runs" orientation="stack">
                  <NbSelect
                    :id="id"
                    :model-value="placed.axis ?? 'h'"
                    :options="GATE_AXES"
                    size="sm"
                    @update:model-value="(v: unknown) => setGateAxis(v === 'v' ? 'v' : 'h')"
                  />
                </NbField>
              </template>
              <template v-if="placedDevice?.kind === 'heating'">
                <NbField label="Rooms its water circuit serves" orientation="stack">
                  <div class="house-editor__checks">
                    <NbCheckbox
                      v-for="r in walledRooms"
                      :key="r.id"
                      :label="`${r.name} (${r.floor})`"
                      :model-value="placed.circuitRooms?.includes(r.id) ?? false"
                      @update:model-value="(v?: boolean) => toggleCircuitRoom(r.id, !!v)"
                    />
                  </div>
                </NbField>
              </template>
              <div class="house-editor__row">
                <span />
                <NbButton size="sm" variant="secondary" @click="removePlaced">Remove from plan</NbButton>
              </div>
            </NbPanel>

            <NbPanel v-else :title="floor.name" :flat="true">
              <NbField v-slot="{ id }" label="Floor name" orientation="stack">
                <NbTextInput :id="id" v-model="floor.name" size="sm" :maxlength="80" />
              </NbField>
              <template v-if="floor.level === 0">
                <NbField v-slot="{ id }" label="Plot width (m)" orientation="stack">
                  <NbNumberInput
                    :id="id"
                    :model-value="plan.plot.w / CELLS_PER_M"
                    :min="minPlot.w / CELLS_PER_M"
                    :max="200"
                    :step="0.5"
                    size="sm"
                    @update:model-value="(v: number | null) => setPlot('w', v)"
                  />
                </NbField>
                <NbField v-slot="{ id }" label="Plot depth (m)" orientation="stack">
                  <NbNumberInput
                    :id="id"
                    :model-value="plan.plot.h / CELLS_PER_M"
                    :min="minPlot.h / CELLS_PER_M"
                    :max="200"
                    :step="0.5"
                    size="sm"
                    @update:model-value="(v: number | null) => setPlot('h', v)"
                  />
                </NbField>
              </template>
              <div class="house-editor__row">
                <span class="house-editor__muted">
                  {{ hasFloorBelow ? 'The dashed outline is the floor below.' : '' }}
                </span>
                <NbButton v-if="plan.floors.length > 1" size="sm" variant="danger" icon="trash" @click="deleteFloor">
                  Delete floor
                </NbButton>
              </div>
            </NbPanel>
          </template>
          <template #library>
            <HouseLibrary :unplaced="unplaced" :active="libraryActive" @pick="pickItem" @grab="grabItem" />
          </template>
          <template #house>
            <HouseOutline :plan="plan" :devices="devices" :selected="outlineSelected" @pick="pickOutline" />
          </template>
        </NbTabs>
      </aside>
    </Teleport>

    <div v-if="ghost" class="house-editor__ghost" :style="{ left: `${ghost.x}px`, top: `${ghost.y}px` }">
      {{ ghost.name }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useConfirm, usePhoneLayout, useToast } from '@nubisco/ui'
import { useInspectorStore } from '@/stores/inspector'
import HouseFloorMenu from '@/components/house/HouseFloorMenu.vue'
import HouseRuler from '@/components/house/HouseRuler.vue'
import HouseLibrary from '@/components/house/HouseLibrary.vue'
import HouseOutline, { outlineId, type OutlinePick } from '@/components/house/HouseOutline.vue'
import HouseStage from '@/components/house/HouseStage.vue'
import type { LibraryItem } from '@/house/library'
import { RULER_SIZE } from '@/house/ruler'
import { History } from '@house-model/history'
import type {
  HouseFloor,
  HouseFurniture,
  HouseFurnitureKind,
  HouseLightMount,
  HouseLook,
  HouseOpening,
  HousePlan,
  HouseRadiator,
  HouseRect,
  HouseRoom,
} from '@/api'
import {
  CELLS_PER_M,
  FURNITURE_BACK,
  FURNITURE_HEIGHT,
  S,
  clamp,
  flippedSide,
  furnitureHeight,
  lightMount,
  radiatorRoom,
  roomArea,
  roomRects,
} from '@/house/geometry'
import {
  FURNITURE_NAME,
  addFloor,
  addFurniture,
  addOpenWall,
  flipFurniture,
  moveFurniture,
  removeFurniture,
  resizeFurniture,
  turnFurniture,
  addRadiator,
  moveRadiator,
  radiatorFits,
  removeRadiator,
  resizeRadiator,
  addOpening,
  addPart,
  addRoom,
  fitsFree,
  moveOpening,
  nearestWall,
  openingAt,
  place,
  removeFloor,
  removeOpening,
  removePart,
  resizeOpening,
  roomPayload,
  unplace,
  renderEditor,
  replacePlan,
  setPlotSize,
  shapeValid,
} from '@/house/editor'
import { KIND_LABEL, LOOK_LABEL, type LiveDevice } from '@/house/live'
import {
  COVERING_LABEL,
  DOOR_OPERATION_LABEL,
  DOOR_PRESETS,
  FRAME_COLOURS,
  FRAME_LABEL,
  LEAF_LABEL,
  PRESETS,
  WINDOW_OPERATION_LABEL,
  WINDOW_PRESETS,
  addCovering,
  applyPreset,
  coveringsOf,
  detach,
  drive,
  driverOf,
  ensureSpec,
  isGlazed,
  openingName,
  presetOf,
  removeCovering,
  setLeaf,
  setOpeningKind,
  setOperation,
  specOf,
  type CoveringKind,
  type OpeningPreset,
} from '@/house/openings'
import { WARM_LIGHT } from '@/house/scene'

const props = defineProps<{
  /** The draft. Edited in place. */
  plan: HousePlan
  devices: Map<string, LiveDevice>
  allDevices: LiveDevice[]
  initialFloor: string | null
}>()

const { phone } = usePhoneLayout()
const inspector = useInspectorStore()
// The panels open with the editor on a wide screen, and go with it.
onMounted(() => {
  if (!phone.value) inspector.openHouseEditor()
})
onBeforeUnmount(() => {
  if (inspector.mode === 'house-editor') inspector.close()
})
const confirm = useConfirm()
const toast = useToast()

// Garden and Pool draw the same rectangles as Room, without walls. The type
// can still be changed afterwards in the room's panel.
const TOOLS = [
  { id: 'select', label: 'Select', icon: 'cursor' },
  { id: 'room', label: 'Room', icon: 'bounding-box' },
  { id: 'outdoor', label: 'Garden', icon: 'tree' },
  { id: 'paved', label: 'Paving', icon: 'squares-four' },
  { id: 'pool', label: 'Pool', icon: 'swimming-pool' },
  { id: 'door', label: 'Door', icon: 'door-open' },
  { id: 'window', label: 'Window', icon: 'app-window' },
  { id: 'open', label: 'Open wall', icon: 'arrows-out-line-horizontal' },
  { id: 'radiator', label: 'Radiator', icon: 'thermometer-hot' },
  { id: 'furniture', label: 'Furniture', icon: 'armchair' },
]
const FURNITURE_KINDS = (Object.keys(FURNITURE_NAME) as HouseFurnitureKind[]).map((k) => ({
  label: FURNITURE_NAME[k],
  value: k,
}))
const ROOM_KINDS = [
  { label: 'Room (has walls)', value: 'room' },
  { label: 'Outdoor zone', value: 'outdoor' },
  { label: 'Paving', value: 'paved' },
  { label: 'Pool', value: 'pool' },
]
const OPENING_KINDS = [
  { label: 'Door', value: 'door' },
  { label: 'Window', value: 'window' },
  { label: 'Open, no wall', value: 'open' },
]
const options = <K extends string>(labels: Record<K, string>) =>
  (Object.keys(labels) as K[]).map((k) => ({ label: labels[k], value: k }))
const FRAME_OPTIONS = [{ label: 'Not said', value: '' }, ...options(FRAME_LABEL)]
const COLOUR_OPTIONS = [{ label: 'Not said', value: '' }, ...FRAME_COLOURS]
const COVERING_OPTIONS = options(COVERING_LABEL)
const SIDE_OPTIONS = [
  { label: 'Outside', value: 'outside' },
  { label: 'Inside', value: 'inside' },
]
const GATE_AXES = [
  { label: 'Left to right', value: 'h' },
  { label: 'Front to back', value: 'v' },
]
const LIGHT_MOUNTS = [
  { label: 'Ceiling', value: 'ceiling' },
  { label: 'Wall', value: 'wall' },
  { label: 'Floor lamp', value: 'floor' },
  { label: 'Table lamp', value: 'table' },
  { label: 'In the pool', value: 'pool' },
]
const GLOW_COLOURS = [
  { label: 'Warm white', value: WARM_LIGHT },
  { label: 'Neutral white', value: '#ffe1b3' },
  { label: 'Cool white', value: '#cfe3ff' },
  { label: 'Blue', value: '#6f8bff' },
  { label: 'Green', value: '#5fe0a0' },
  { label: 'Pink', value: '#ff5fd2' },
  { label: 'Red', value: '#ff5a4d' },
]

type Tool = 'select' | 'room' | 'outdoor' | 'paved' | 'pool' | 'door' | 'window' | 'open' | 'radiator' | 'furniture'
const isAreaTool = (t: Tool): t is 'room' | 'outdoor' | 'paved' | 'pool' =>
  t === 'room' || t === 'outdoor' || t === 'paved' || t === 'pool'
const tool = ref<Tool>('room')
/** The top floor, where the editor opens when no single floor was in view. */
const topFloor = () => props.plan.floors.reduce((a, b) => (b.level > a.level ? b : a))
const floorId = ref(props.plan.floors.some((f) => f.id === props.initialFloor) ? props.initialFloor! : topFloor().id)
const selRoom = ref<string | null>(null)
const selRef = ref<string | null>(null)
const selOpening = ref<string | null>(null)
const selRadiator = ref<string | null>(null)
const selFurniture = ref<string | null>(null)
/** What the Door and Window tools put down next. */
const doorPreset = ref(DOOR_PRESETS[0].id)
const windowPreset = ref(WINDOW_PRESETS[0].id)
/** What the Furniture tool puts down next. */
const furnitureKind = ref<HouseFurnitureKind>('table')
const armed = ref<string | null>(null)
const draft = ref<Pick<HouseRoom, 'x' | 'y' | 'w' | 'h'> | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const unit = ref(1)

const floor = computed<HouseFloor>(() => props.plan.floors.find((f) => f.id === floorId.value) ?? props.plan.floors[0])
const room = computed(() => floor.value.rooms.find((r) => r.id === selRoom.value) ?? null)
const opening = computed(() => floor.value.openings.find((o) => o.id === selOpening.value) ?? null)
const piece = computed(() => (floor.value.furniture ?? []).find((f) => f.id === selFurniture.value) ?? null)
const radiator = computed(() => (floor.value.radiators ?? []).find((r) => r.id === selRadiator.value) ?? null)
/** "Heats the Kitchen, from Heat pump", or why it does not. */
const radiatorText = computed(() => {
  const r = radiator.value
  if (!r) return ''
  const room = radiatorRoom(floor.value, r)
  if (!room) return 'It is not in a room.'
  const feed = props.plan.floors.flatMap((f) => f.placements).find((p) => p.circuitRooms?.includes(room.id))
  const name = feed ? (props.devices.get(feed.ref)?.name ?? 'a heating device') : null
  return name
    ? `Heats ${room.name}, on the circuit from ${name}.`
    : `Heats ${room.name}. No heating circuit serves this room yet: tick it on a heating device.`
})
const placed = computed(() => floor.value.placements.find((p) => p.ref === selRef.value) ?? null)
const placedDevice = computed(() => (placed.value ? props.devices.get(placed.value.ref) : undefined))
const unplaced = computed(() => {
  const on = new Set(props.plan.floors.flatMap((f) => f.placements.map((p) => p.ref)))
  return props.allDevices.filter((d) => !on.has(d.ref)).sort((a, b) => a.name.localeCompare(b.name))
})
const walledRooms = computed(() =>
  props.plan.floors.flatMap((f) => f.rooms.filter((r) => r.kind === 'room').map((r) => ({ ...r, floor: f.name }))),
)
/** The plot cannot shrink under a room. */
const minPlot = computed(() => {
  const rooms = props.plan.floors.flatMap((f) => f.rooms)
  return {
    w: Math.max(2, ...rooms.map((r) => r.x + r.w)),
    h: Math.max(2, ...rooms.map((r) => r.y + r.h)),
  }
})

// ─── Zoom and pan ───────────────────────────────────────────────────────────
// Only the blueprint zooms: the viewBox narrows onto the plan, and the tools
// and panels around it keep their size. As in a design tool, scrolling pans,
// and a pinch, or scrolling with Ctrl or Cmd held, zooms about the pointer.

const MIN_ZOOM = 0.5
const MAX_ZOOM = 40
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const zoom = ref(1)
/** The point at the middle of the view, in stage units. Unset, the plot's middle. */
const center = ref<[number, number] | null>(null)
/** The canvas's size in pixels. The blueprint fills it, under the rulers and tools. */
const canvasSize = ref({ w: 0, h: 0 })
/**
 * What zoom 1 shows: the plot with half a metre round it, fitted between the
 * rulers, the toolbar, the zoom buttons and the hint, and the canvas round
 * that, so a zoomed plan runs to every edge.
 */
const home = computed(() => {
  const pad = 0.5 * CELLS_PER_M * S
  const plot = { x: -pad, y: -pad, w: props.plan.plot.w * S + 2 * pad, h: props.plan.plot.h * S + 2 * pad }
  const { w: W, h: H } = canvasSize.value
  if (!W || !H) return plot
  // Clear of the rulers and of what floats over the canvas, in pixels.
  const inset = phone.value
    ? { t: RULER_SIZE + 8, r: 8, b: 52, l: RULER_SIZE + 8 }
    : { t: RULER_SIZE + 64, r: 64, b: 60, l: RULER_SIZE + 16 }
  const iw = Math.max(1, W - inset.l - inset.r)
  const ih = Math.max(1, H - inset.t - inset.b)
  const k = Math.min(iw / plot.w, ih / plot.h)
  return {
    x: plot.x - (inset.l + (iw - plot.w * k) / 2) / k,
    y: plot.y - (inset.t + (ih - plot.h * k) / 2) / k,
    w: W / k,
    h: H / k,
  }
})
/** On a phone the canvas takes the plot's shape, so the plan fills its width. */
const phoneAspect = computed(() => `${props.plan.plot.w + 1} / ${props.plan.plot.h + 1}`)
const viewBox = computed(() => {
  const b = home.value
  const c = center.value ?? [b.x + b.w / 2, b.y + b.h / 2]
  const w = b.w / zoom.value
  const h = b.h / zoom.value
  return `${c[0] - w / 2} ${c[1] - h / 2} ${w} ${h}`
})

/** A screen point in stage units. */
function toStage(clientX: number, clientY: number): [number, number] | null {
  const m = svgEl.value?.getScreenCTM()
  if (!m) return null
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse())
  return [p.x, p.y]
}

/** Zoom by a factor, keeping the point under `at` (a screen point) where it is. */
function zoomBy(f: number, at?: { clientX: number; clientY: number }) {
  const next = clamp(zoom.value * f, MIN_ZOOM, MAX_ZOOM)
  const k = next / zoom.value
  if (k === 1) return
  const b = home.value
  const c = center.value ?? [b.x + b.w / 2, b.y + b.h / 2]
  const p = (at && toStage(at.clientX, at.clientY)) ?? c
  center.value = [p[0] - (p[0] - c[0]) / k, p[1] - (p[1] - c[1]) / k]
  zoom.value = next
}

/** Move the plan by a distance in screen pixels. */
function panBy(dx: number, dy: number) {
  const k = svgEl.value?.getScreenCTM()?.a
  if (!k) return
  const b = home.value
  const c = center.value ?? [b.x + b.w / 2, b.y + b.h / 2]
  center.value = [c[0] - dx / k, c[1] - dy / k]
}

function resetView() {
  zoom.value = 1
  center.value = null
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  // Lines and pages, from some mice, in pixels.
  const unitPx = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  const dx = e.deltaX * unitPx
  const dy = e.deltaY * unitPx
  // A trackpad pinch arrives as a wheel with ctrlKey, in small steps. A mouse
  // wheel's notch is about 100 pixels, held here to half a notch's worth.
  if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-clamp(dy, -40, 40) * 0.01), e)
  else if (e.shiftKey && !dx) panBy(-dy, 0)
  else panBy(-dx, -dy)
}

// Space held, or the middle button, drags the plan. So do two fingers, which
// also pinch.
const spaceHeld = ref(false)
const panning = ref(false)
let panFrom: [number, number] = [0, 0]
const touches = new Map<number, [number, number]>()
let pinch: { dist: number; zoom: number; mid: [number, number] } | null = null

function typing(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
}
function onKeyDown(e: KeyboardEvent) {
  if (typing(e.target)) return
  // Space presses a focused button, so it pans only over the page or the canvas.
  if (e.code === 'Space') {
    const t = e.target
    if (t !== document.body && !(t instanceof Node && canvasEl.value?.contains(t))) return
    spaceHeld.value = true
    e.preventDefault()
    return
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 'z' && e.shiftKey) redo()
  else if (key === 'z') undo()
  else if (key === 'y') redo()
  else if (e.key === '=' || e.key === '+') zoomBy(1.4)
  else if (e.key === '-') zoomBy(1 / 1.4)
  else if (e.key === '0') resetView()
  else return
  e.preventDefault()
}
function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') spaceHeld.value = false
}

/** Where the pointer is over the canvas, in pixels from its corner, for the rulers. */
const cursor = ref<[number, number] | null>(null)
const canvasEl = ref<HTMLElement | null>(null)
/** How the plan sits on the canvas: metre 0 and the scale, for the rulers. */
const view = ref({ pxPerM: 0, ox: 0, oy: 0, w: 0, h: 0 })

const markup = computed(() =>
  renderEditor(props.plan, floor.value, props.devices, {
    selectedRoom: selRoom.value,
    selectedRef: selRef.value,
    selectedOpening: selOpening.value,
    selectedRadiator: selRadiator.value,
    selectedFurniture: selFurniture.value,
    draft: draft.value,
    unit: unit.value,
    zoom: zoom.value,
    showHandles: tool.value === 'select',
  }),
)

const help = computed(() => {
  if (wingFor.value) return 'Drag a rectangle along an edge of the room to join it as a wing, making an L or a U.'
  if (armed.value) return `Now tap the plan where "${props.devices.get(armed.value)?.name ?? 'it'}" is.`
  return {
    select: 'Drag a room to move it, or its corners to resize it. Drag a device to move it. Tap anything to edit it.',
    room: 'Drag on the grid to draw a room. It snaps to half a metre. Draw one inside another for a room within a room.',
    outdoor: 'Drag on the grid to draw a garden or a lawn. It has no walls.',
    paved:
      'Drag on the grid to draw paving: a terrace, a path, a drive, or the deck round the pool. Draw the pool inside it.',
    pool: 'Drag on the grid to draw a pool.',
    door: 'Pick a door in the Library, then tap a wall to put one there. Drag a door to move it, or its ends to resize it.',
    window:
      'Pick a window in the Library, then tap a wall to put one there. Drag a window to move it, or its ends to resize it.',
    radiator:
      'Tap a wall, on the side the radiator hangs, to put one there. Drag it to move it, or its ends to resize it. A heating circuit serving the room runs through it.',
    furniture:
      'Pick a piece in the Library, then drag on the plan to draw it to size, or tap to put one of the usual size there. Drag a piece to move it, or a corner to resize it.',
    open: 'Tap a wall that is not really there, such as between a kitchen and the living room, and it is left out.',
  }[tool.value]
})

const metres = (cells: number) => String(Math.round((cells / CELLS_PER_M) * 100) / 100)

function setTool(id: string) {
  tool.value = id as Tool
  armed.value = null
  wingFor.value = null
}

/** The room the next rectangle drawn joins as a wing, while adding one. */
const wingFor = ref<string | null>(null)

function toggleWing() {
  wingFor.value = wingFor.value === selRoom.value ? null : selRoom.value
}

function removeWing(i: number) {
  if (room.value) removePart(room.value, i)
}

function clearSelection() {
  wingFor.value = null
  selRoom.value = null
  selRef.value = null
  selOpening.value = null
  selRadiator.value = null
  selFurniture.value = null
}

function selectFloor(id: string) {
  floorId.value = id
  clearSelection()
}

function newFloor() {
  const f = addFloor(props.plan)
  floorId.value = f.id
  clearSelection()
  selRoom.value = f.rooms[0]?.id ?? null
  tool.value = 'select'
}

function renameFloor(id: string, name: string) {
  const f = props.plan.floors.find((x) => x.id === id)
  if (f) f.name = name
}

const hasFloorBelow = computed(() => props.plan.floors.some((f) => f.level < floor.value.level))

async function deleteFloor() {
  const f = floor.value
  const devices = f.placements.length
  const ok = await confirm({
    title: 'Delete floor',
    subjectLabel: 'Floor',
    subject: f.name,
    message: devices
      ? `Its rooms go, and its ${devices} device${devices === 1 ? '' : 's'} move back to "Not on the plan yet". Nothing is saved until you save the plan.`
      : 'Its rooms go. Nothing is saved until you save the plan.',
    confirmLabel: 'Delete',
  })
  if (!ok) return
  removeFloor(props.plan, f.id)
  floorId.value = topFloor().id
  clearSelection()
}

function deleteRoom() {
  floor.value.rooms = floor.value.rooms.filter((r) => r.id !== selRoom.value)
  selRoom.value = null
}

function setRadiatorLength(v: number | null) {
  const r = radiator.value
  if (!r || v === null) return
  const want = clamp(Math.round(v * CELLS_PER_M * 2) / 2, 1, 10)
  let len = r.len
  const step = want > len ? 0.5 : -0.5
  while (len !== want && radiatorFits(floor.value, { ...r, len: len + step })) len += step
  r.len = len
}

function flipRadiator() {
  const r = radiator.value
  if (!r) return
  const side = ({ up: 'down', down: 'up', left: 'right', right: 'left' } as const)[r.side]
  if (radiatorFits(floor.value, { ...r, side })) r.side = side
  else toast.warning('The other side of this wall already has a radiator there.')
}

function deleteRadiator() {
  if (radiator.value) removeRadiator(floor.value, radiator.value.id)
  selRadiator.value = null
}

function setPieceSize(side: 'w' | 'd', v: number | null) {
  const f = piece.value
  if (!f || v === null) return
  const cells = clamp(Math.round(v * CELLS_PER_M * 2) / 2, 0.5, side === 'w' ? props.plan.plot.w : props.plan.plot.h)
  f[side] = cells
  // Grown past the plot's edge, it moves back onto it.
  if (side === 'w') f.x = clamp(f.x, 0, props.plan.plot.w - f.w)
  else f.y = clamp(f.y, 0, props.plan.plot.h - f.d)
}

function setPieceHeight(v: number | null) {
  const f = piece.value
  if (!f || v === null) return
  const m = clamp(Math.round(v * 100) / 100, 0.1, 3)
  // The usual height for its kind is left unset, so changing the kind keeps it right.
  if (m === FURNITURE_HEIGHT[f.kind]) delete f.height
  else f.height = m
}

function turnPiece() {
  if (piece.value) turnFurniture(props.plan, floor.value, piece.value)
}

function flipPiece() {
  if (piece.value) flipFurniture(floor.value, piece.value)
}

/** What the panel says about the selected piece: where its back is, and what stands on it. */
const pieceText = computed(() => {
  const f = piece.value
  if (!f) return ''
  const parts: string[] = []
  if (FURNITURE_BACK[f.kind]) {
    parts.push(
      f.kind === 'bed' || f.kind === 'lounger'
        ? 'The heavy line on the plan is its head.'
        : 'The heavy line on the plan is its back.',
    )
  }
  if (['table', 'cabinet', 'island', 'bed', 'shelves', 'basin'].includes(f.kind))
    parts.push('A lamp put on it stands on it.')
  parts.push('Drag it to move it, or drag a corner to resize it.')
  return parts.join(' ')
})

function deletePiece() {
  if (piece.value) removeFurniture(floor.value, piece.value.id)
  selFurniture.value = null
}

function deleteOpening() {
  if (opening.value) removeOpening(floor.value, opening.value.id)
  selOpening.value = null
}

function setOpeningLength(v: number | null) {
  const o = opening.value
  if (!o || v === null) return
  // In quarter metres, growing only along wall and never over another opening.
  const want = clamp(Math.round(v * CELLS_PER_M * 2) / 2, 1, 40)
  let len = o.len
  const step = want > len ? 0.5 : -0.5
  while (len !== want && fitsFree(floor.value, { ...o, len: len + step })) len += step
  o.len = len
}

/** Lights, shutters and gates are drawn from what they report. Everything else can say what it is. */
const takesLook = (d: LiveDevice) => d.kind !== 'light' && d.kind !== 'shutter' && d.kind !== 'gate'

const lookOptions = computed(() => {
  const d = placedDevice.value
  const fallback = d?.defaultLook ? LOOK_LABEL[d.defaultLook] : d ? KIND_LABEL[d.kind] : 'Device'
  return [
    { label: `As its type (${fallback.toLowerCase()})`, value: '' },
    ...Object.entries(LOOK_LABEL).map(([value, label]) => ({ label, value })),
  ]
})

function setLook(look: HouseLook | null) {
  const p = placed.value
  if (!p) return
  if (look) p.look = look
  else delete p.look
}

function setMount(mount: HouseLightMount) {
  const p = placed.value
  if (!p) return
  // The default for where it stands is left unset, so moving the light
  // into or out of a pool keeps it right.
  if (mount === lightMount(floor.value, { x: p.x, y: p.y })) delete p.mount
  else p.mount = mount
}

/** "Hinged on the left, opens down", in the plan's own terms. */
const doorText = computed(() => {
  const o = opening.value
  if (!o) return ''
  const hinge = o.axis === 'h' ? (o.hinge === 'end' ? 'right' : 'left') : o.hinge === 'end' ? 'bottom' : 'top'
  const side = o.opens ?? (o.axis === 'h' ? 'down' : 'right')
  return `Hinged at the ${hinge}, opens ${side === 'up' || side === 'down' ? side + 'wards' : 'to the ' + side} on the plan.`
})

/** What a shutter or blind device drives, said in the device's panel. */
const placedDriveText = computed(() => {
  const p = placed.value
  const o = p?.opening ? floor.value.openings.find((x) => x.id === p.opening) : undefined
  if (!p || !o) return "Drag it onto a window to attach it there, or pick it in a window's Coverings."
  const c = coveringsOf(o).find((x) => x.id === p.covering)
  const what = c ? COVERING_LABEL[c.kind].toLowerCase() : 'covering'
  return `Drives the ${what} of the ${openingName(o).toLowerCase()}, and is drawn on it.`
})

/** The preset the Door or Window tool puts down. */
function toolPreset(): OpeningPreset {
  if (tool.value === 'window') return WINDOW_PRESETS.find((p) => p.id === windowPreset.value) ?? WINDOW_PRESETS[0]
  return DOOR_PRESETS.find((p) => p.id === doorPreset.value) ?? DOOR_PRESETS[0]
}

/** The selected door's or window's detail, filled in. Null for an open wall. */
const openingSpec = computed(() => (opening.value && opening.value.type !== 'open' ? specOf(opening.value) : null))
const glazed = computed(() => !!opening.value && isGlazed(opening.value))
const coverings = computed(() => (opening.value ? coveringsOf(opening.value) : []))

const presetOptions = computed(() => {
  const kind = openingSpec.value?.kind
  const list = PRESETS.filter((p) => p.kind === kind).map((p) => ({ label: p.label, value: p.id }))
  return opening.value && presetOf(opening.value) ? list : [{ label: 'Custom', value: '' }, ...list]
})
const operationOptions = computed(() =>
  openingSpec.value?.kind === 'window' ? options(WINDOW_OPERATION_LABEL) : options(DOOR_OPERATION_LABEL),
)
// A sliding door is glass, so it cannot have a solid leaf.
const leafOptions = computed(() =>
  options(LEAF_LABEL).filter((x) => x.value !== 'solid' || opening.value?.type !== 'slider'),
)

function pickPreset(id: string) {
  const p = PRESETS.find((x) => x.id === id)
  if (p && opening.value) applyPreset(opening.value, p)
}

function setFrame(key: 'material' | 'colour', v: string) {
  const s = opening.value && ensureSpec(opening.value)
  if (!s) return
  const frame = { ...s.frame } as Record<string, string>
  if (v) frame[key] = v
  else delete frame[key]
  if (Object.keys(frame).length) s.frame = frame
  else delete s.frame
}

/** Sill and head in metres, kept at least 10 cm apart. */
function setHeight(key: 'sill' | 'head', v: number | null) {
  const s = opening.value && ensureSpec(opening.value)
  if (!s || v === null) return
  const mm = Math.round(clamp(v, 0, 4) * 1000)
  if (key === 'sill') s.sill = Math.min(mm, (s.head ?? 2100) - 100)
  else s.head = Math.max(mm, (s.sill ?? 0) + 100)
}

/** A shutter outside first, then curtains inside. */
function addNextCovering() {
  const o = opening.value
  if (!o) return
  const has = (k: CoveringKind) => coverings.value.some((c) => c.kind === k)
  addCovering(o, !has('shutter') ? 'shutter' : !has('curtain') ? 'curtain' : 'blind')
}

/** Devices that can drive a covering: shutters and blinds placed on this floor. */
function driverOptions(covering: string) {
  const o = opening.value
  const list = floor.value.placements
    .filter((p) => props.devices.get(p.ref)?.kind === 'shutter')
    .filter((p) => !p.opening || (o && p.opening === o.id && driverOf(floor.value, o, covering) === p) || !o)
    .map((p) => ({ label: props.devices.get(p.ref)?.name ?? p.ref, value: p.ref }))
  return [{ label: 'By hand, no motor', value: '' }, ...list]
}

function setDriver(covering: string, ref: string) {
  const o = opening.value
  if (!o) return
  const current = driverOf(floor.value, o, covering)
  if (!ref) {
    if (current) detach(current)
    return
  }
  const p = floor.value.placements.find((x) => x.ref === ref)
  if (p) drive(floor.value, o, covering, p)
}

function flipHinge() {
  const o = opening.value
  if (!o) return
  if (o.hinge === 'end') delete o.hinge
  else o.hinge = 'end'
}

function flipSide() {
  const o = opening.value
  if (o) o.opens = flippedSide(o)
}

function setColor(c: string) {
  if (placed.value) placed.value.color = c
}

function setGateLength(v: number | null) {
  if (placed.value && v !== null) placed.value.length = clamp(Math.round(v * CELLS_PER_M), 1, 40)
}

function setGateAxis(axis: 'h' | 'v') {
  if (placed.value) placed.value.axis = axis
}

function toggleCircuitRoom(id: string, on: boolean) {
  const p = placed.value
  if (!p) return
  const list = new Set(p.circuitRooms ?? [])
  if (on) list.add(id)
  else list.delete(id)
  if (list.size) p.circuitRooms = [...list]
  else delete p.circuitRooms
}

function removePlaced() {
  if (placed.value) unplace(props.plan, placed.value.ref)
  selRef.value = null
}

function setPlot(axis: 'w' | 'h', v: number | null) {
  if (v === null) return
  setPlotSize(props.plan, axis, v * CELLS_PER_M)
}

// ─── Pointer ────────────────────────────────────────────────────────────────

type Drag =
  | { type: 'draw'; x0: number; y0: number }
  | {
      type: 'resize'
      room: HouseRoom
      /** The part being resized: the room itself, or one of its wings. */
      r: HouseRect
      corner: string
      o: { x1: number; y1: number; x2: number; y2: number }
    }
  | {
      type: 'move'
      r: HouseRoom
      start: { x: number; y: number }
      /** Where each part started, main rectangle first. */
      o: HouseRect[]
      payload: ReturnType<typeof roomPayload>
    }
  | { type: 'device'; ref: string }
  | { type: 'omove'; o: HouseOpening; grab: number }
  | { type: 'oresize'; o: HouseOpening; end: 'start' | 'end' }
  | { type: 'rmove'; r: HouseRadiator; grab: number }
  | { type: 'rresize'; r: HouseRadiator; end: 'start' | 'end' }
  | { type: 'fdraw'; x0: number; y0: number }
  | { type: 'fmove'; f: HouseFurniture; grab: { x: number; y: number } }
  | { type: 'fresize'; f: HouseFurniture; corner: string; o: { x1: number; y1: number; x2: number; y2: number } }
let drag: Drag | null = null

/** Start dragging the opening under the pointer, or one of the selected opening's ends. */
function grabOpening(t: Element | null, p: { x: number; y: number }): boolean {
  // Radiators are grabbed the same way: by their line, or the selected one's ends.
  const rend = t?.closest('[data-rhandle]')?.getAttribute('data-rhandle')
  if (rend && radiator.value) {
    drag = { type: 'rresize', r: radiator.value, end: rend === 'end' ? 'end' : 'start' }
    return true
  }
  const rid = t?.closest('[data-radiator]')?.getAttribute('data-radiator')
  const rad = rid ? (floor.value.radiators ?? []).find((x) => x.id === rid) : undefined
  if (rad) {
    clearSelection()
    selRadiator.value = rad.id
    drag = { type: 'rmove', r: rad, grab: (rad.axis === 'h' ? p.x : p.y) - (rad.axis === 'h' ? rad.x : rad.y) }
    return true
  }
  const end = t?.closest('[data-ohandle]')?.getAttribute('data-ohandle')
  if (end && opening.value) {
    drag = { type: 'oresize', o: opening.value, end: end === 'end' ? 'end' : 'start' }
    return true
  }
  const id = t?.closest('[data-opening]')?.getAttribute('data-opening')
  const o = id ? floor.value.openings.find((x) => x.id === id) : undefined
  if (!o) return false
  clearSelection()
  selOpening.value = o.id
  drag = { type: 'omove', o, grab: (o.axis === 'h' ? p.x : p.y) - (o.axis === 'h' ? o.x : o.y) }
  return true
}

/** Start dragging the piece of furniture under the pointer, or a corner of the selected one. */
function grabFurniture(t: Element | null, p: { x: number; y: number }): boolean {
  const corner = t?.closest('[data-fhandle]')?.getAttribute('data-fhandle')
  const f = piece.value
  if (corner && f) {
    drag = { type: 'fresize', f, corner, o: { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.d } }
    return true
  }
  const id = t?.closest('[data-furniture]')?.getAttribute('data-furniture')
  const hit = id ? (floor.value.furniture ?? []).find((x) => x.id === id) : undefined
  if (!hit) return false
  clearSelection()
  selFurniture.value = hit.id
  drag = { type: 'fmove', f: hit, grab: { x: p.x - hit.x, y: p.y - hit.y } }
  return true
}

function toGrid(e: { clientX: number; clientY: number }) {
  const m = svgEl.value?.getScreenCTM()
  if (!m) return { x: 0, y: 0 }
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
  return { x: p.x / S, y: p.y / S }
}

function measureUnit() {
  const m = svgEl.value?.getScreenCTM()
  unit.value = m && m.a ? 1 / m.a : 1
  const box = canvasEl.value?.getBoundingClientRect()
  if (m && box)
    view.value = { pxPerM: m.a * S * CELLS_PER_M, ox: m.e - box.left, oy: m.f - box.top, w: box.width, h: box.height }
}

function placeAt(ref: string, p: { x: number; y: number }) {
  const d = props.devices.get(ref)
  if (!d) return
  place(props.plan, floor.value, d, p.x, p.y)
  armed.value = null
  clearSelection()
  selRef.value = ref
}

function capture(e: PointerEvent) {
  try {
    svgEl.value?.setPointerCapture(e.pointerId)
  } catch {
    /* a synthetic pointer has nothing to capture */
  }
}

function onDown(e: PointerEvent) {
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, [e.clientX, e.clientY])
    if (touches.size === 2) {
      // A second finger: the plan is being zoomed or moved, not drawn on.
      drag = null
      draft.value = null
      const [a, b] = [...touches.values()]
      pinch = {
        dist: Math.hypot(a[0] - b[0], a[1] - b[1]),
        zoom: zoom.value,
        mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      }
      capture(e)
      return
    }
    if (touches.size > 2) return
  }
  if (e.button === 1 || spaceHeld.value) {
    e.preventDefault()
    panning.value = true
    panFrom = [e.clientX, e.clientY]
    capture(e)
    return
  }
  const p = toGrid(e)
  const pw = props.plan.plot.w
  const ph = props.plan.plot.h
  const t = e.target instanceof Element ? e.target : null
  if (armed.value) return placeAt(armed.value, p)

  if (isAreaTool(tool.value) || wingFor.value) {
    const x0 = clamp(Math.round(p.x), 0, pw)
    const y0 = clamp(Math.round(p.y), 0, ph)
    drag = { type: 'draw', x0, y0 }
    draft.value = { x: x0, y: y0, w: 0, h: 0 }
  } else if (tool.value === 'door' || tool.value === 'window' || tool.value === 'open') {
    if (!grabOpening(t, p)) {
      const u = nearestWall(floor.value, p.x, p.y)
      clearSelection()
      if (!u) return
      const existing = openingAt(floor.value, u)
      const o =
        existing ?? (tool.value === 'open' ? addOpenWall(floor.value, u) : addOpening(floor.value, u, toolPreset()))
      if (o) selOpening.value = o.id
      if (existing)
        drag = {
          type: 'omove',
          o: existing,
          grab: (u.axis === 'h' ? p.x : p.y) - (u.axis === 'h' ? existing.x : existing.y),
        }
    }
  } else if (tool.value === 'furniture') {
    if (!grabFurniture(t, p)) {
      clearSelection()
      const x0 = clamp(Math.round(p.x * 2) / 2, 0, pw)
      const y0 = clamp(Math.round(p.y * 2) / 2, 0, ph)
      drag = { type: 'fdraw', x0, y0 }
      draft.value = { x: x0, y: y0, w: 0, h: 0 }
    }
  } else if (tool.value === 'radiator') {
    if (!grabOpening(t, p)) {
      const u = nearestWall(floor.value, p.x, p.y)
      clearSelection()
      if (!u) return
      const r = addRadiator(floor.value, u, p.x, p.y)
      if (r) selRadiator.value = r.id
      else toast.warning('There is no room for a radiator there. It needs wall, not a doorway, on the side of a room.')
    }
  } else if (grabOpening(t, p)) {
    /* a door, window or radiator, or one of its ends, is being dragged */
  } else {
    const handle = t?.closest('[data-handle]')
    const dev = t?.closest('[data-ref]')
    const rm = t?.closest('[data-room]')
    if (handle && room.value) {
      const [index, corner] = (handle.getAttribute('data-handle') as string).split(':')
      const r = roomRects(room.value)[Number(index)]
      if (!r) return
      drag = {
        type: 'resize',
        room: room.value,
        r,
        corner,
        o: { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h },
      }
    } else if (dev) {
      clearSelection()
      selRef.value = dev.getAttribute('data-ref')
      drag = { type: 'device', ref: selRef.value as string }
    } else if (grabFurniture(t, p)) {
      /* a piece of furniture, or one of its corners, is being dragged */
    } else if (rm) {
      const r = floor.value.rooms.find((x) => x.id === rm.getAttribute('data-room'))
      if (!r) return
      clearSelection()
      selRoom.value = r.id
      drag = { type: 'move', r, start: p, o: roomRects(r).map((q) => ({ ...q })), payload: roomPayload(floor.value, r) }
    } else {
      // A tap on a wall opening in the select tool edits it.
      const u = nearestWall(floor.value, p.x, p.y, 0.6)
      const o = u ? openingAt(floor.value, u) : undefined
      clearSelection()
      if (o) selOpening.value = o.id
    }
  }
  if (drag) {
    e.preventDefault()
    capture(e)
  }
}

function onMove(e: PointerEvent) {
  const box = canvasEl.value?.getBoundingClientRect()
  if (box && e.pointerType !== 'touch') cursor.value = [e.clientX - box.left, e.clientY - box.top]
  if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY])
  if (pinch) {
    if (touches.size !== 2) return
    const [a, b] = [...touches.values()]
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1])
    pinch.mid = mid
    const want = (pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.dist
    zoomBy(want / zoom.value, { clientX: mid[0], clientY: mid[1] })
    return
  }
  if (panning.value) {
    panBy(e.clientX - panFrom[0], e.clientY - panFrom[1])
    panFrom = [e.clientX, e.clientY]
    return
  }
  if (!drag) return
  const p = toGrid(e)
  const pw = props.plan.plot.w
  const ph = props.plan.plot.h
  if (drag.type === 'draw') {
    const x = clamp(Math.round(p.x), 0, pw)
    const y = clamp(Math.round(p.y), 0, ph)
    draft.value = {
      x: Math.min(x, drag.x0),
      y: Math.min(y, drag.y0),
      w: Math.abs(x - drag.x0),
      h: Math.abs(y - drag.y0),
    }
  } else if (drag.type === 'fdraw') {
    const x = clamp(Math.round(p.x * 2) / 2, 0, pw)
    const y = clamp(Math.round(p.y * 2) / 2, 0, ph)
    draft.value = {
      x: Math.min(x, drag.x0),
      y: Math.min(y, drag.y0),
      w: Math.abs(x - drag.x0),
      h: Math.abs(y - drag.y0),
    }
  } else if (drag.type === 'fmove') {
    moveFurniture(props.plan, drag.f, p.x, p.y, drag.grab)
  } else if (drag.type === 'fresize') {
    resizeFurniture(props.plan, drag.f, drag.corner, drag.o, p.x, p.y)
  } else if (drag.type === 'resize') {
    const { o, r, corner, room: owner } = drag
    let { x1, y1, x2, y2 } = o
    if (corner.includes('w')) x1 = clamp(Math.round(p.x), 0, x2 - 1)
    if (corner.includes('e')) x2 = clamp(Math.round(p.x), x1 + 1, pw)
    if (corner.includes('n')) y1 = clamp(Math.round(p.y), 0, y2 - 1)
    if (corner.includes('s')) y2 = clamp(Math.round(p.y), y1 + 1, ph)
    // A size that would split the room or overlap its own parts is not taken:
    // the part stays at the last size that kept the room in one piece.
    const before = { x: r.x, y: r.y, w: r.w, h: r.h }
    Object.assign(r, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    if (!shapeValid(owner)) Object.assign(r, before)
  } else if (drag.type === 'move') {
    const { r, o, start, payload } = drag
    // The whole shape moves, kept inside the plot by the box around it.
    const box = {
      x: Math.min(...o.map((q) => q.x)),
      y: Math.min(...o.map((q) => q.y)),
      x2: Math.max(...o.map((q) => q.x + q.w)),
      y2: Math.max(...o.map((q) => q.y + q.h)),
    }
    const dx = clamp(Math.round(p.x - start.x), -box.x, pw - box.x2)
    const dy = clamp(Math.round(p.y - start.y), -box.y, ph - box.y2)
    roomRects(r).forEach((q, i) => Object.assign(q, { x: o[i].x + dx, y: o[i].y + dy }))
    for (const q of payload.rooms) {
      roomRects(q.room).forEach((x, i) => Object.assign(x, { x: q.o[i].x + dx, y: q.o[i].y + dy }))
    }
    for (const q of payload.openings) Object.assign(q.o, { x: q.x + dx, y: q.y + dy })
    for (const q of payload.radiators) Object.assign(q.o, { x: q.x + dx, y: q.y + dy })
    for (const q of payload.furniture) Object.assign(q.o, { x: q.x + dx, y: q.y + dy })
    for (const q of payload.placements) Object.assign(q.p, { x: q.x + dx, y: q.y + dy })
  } else if (drag.type === 'omove') {
    moveOpening(floor.value, drag.o, p.x, p.y, drag.grab)
  } else if (drag.type === 'oresize') {
    resizeOpening(floor.value, drag.o, drag.end, p.x, p.y)
  } else if (drag.type === 'rmove') {
    moveRadiator(floor.value, drag.r, p.x, p.y, drag.grab)
  } else if (drag.type === 'rresize') {
    resizeRadiator(floor.value, drag.r, drag.end, p.x, p.y)
  } else if (drag.type === 'device') {
    const ref = drag.ref
    const d = props.devices.get(ref)
    const pl = floor.value.placements.find((x) => x.ref === ref)
    if (!pl) return
    if (d) place(props.plan, floor.value, d, p.x, p.y)
    else Object.assign(pl, { x: clamp(Math.round(p.x * 2) / 2, 0, pw), y: clamp(Math.round(p.y * 2) / 2, 0, ph) })
  }
}

function onUp(e?: PointerEvent) {
  if (e) touches.delete(e.pointerId)
  if (pinch) {
    // The pinch ends with its last finger, so the one left does not draw.
    if (!touches.size) pinch = null
    return
  }
  if (panning.value) {
    panning.value = false
    return
  }
  if (drag?.type === 'fdraw') {
    const d = draft.value
    draft.value = null
    // A drag draws it to size. A tap, or a drag too small to mean anything, puts down the usual size.
    const drawn = d && d.w >= 0.5 && d.h >= 0.5
    const f = addFurniture(
      props.plan,
      floor.value,
      furnitureKind.value,
      drawn ? { x: d.x, y: d.y, w: d.w, d: d.h } : { x: drag.x0, y: drag.y0 },
    )
    clearSelection()
    selFurniture.value = f.id
  } else if (drag?.type === 'draw' && wingFor.value) {
    const d = draft.value
    draft.value = null
    const owner = floor.value.rooms.find((r) => r.id === wingFor.value)
    if (owner && d && d.w >= 1 && d.h >= 1) {
      if (addPart(owner, d)) wingFor.value = null
      else toast.warning('A wing has to share an edge with the room and not overlap it. Try again.')
    }
  } else if (drag?.type === 'draw') {
    const d = draft.value
    draft.value = null
    if (d && d.w >= 1 && d.h >= 1) {
      const r = addRoom(props.plan, floor.value, d, isAreaTool(tool.value) ? tool.value : 'room')
      clearSelection()
      selRoom.value = r.id
    }
  }
  drag = null
  // Every tap or drag is a step of its own, however quickly the next follows.
  settle()
}

// ─── Library ────────────────────────────────────────────────────────────────
// Anything in the Library can be dragged onto the plan, or tapped and then
// put down with a tap on the plan, which is the path that works for a finger
// and a keyboard alike.

const ghost = ref<{ name: string; x: number; y: number } | null>(null)
let chip: { item: LibraryItem; x: number; y: number; moved: boolean } | null = null
let suppressClick = false

function itemName(item: LibraryItem): string {
  if (item.type === 'opening') return item.preset.label
  if (item.type === 'furniture') return FURNITURE_NAME[item.kind]
  return props.devices.get(item.ref)?.name ?? ''
}

/** The Library item the next tap on the plan puts down. */
const libraryActive = computed(() => {
  if (armed.value) return `device:${armed.value}`
  if (tool.value === 'door') return `opening:${doorPreset.value}`
  if (tool.value === 'window') return `opening:${windowPreset.value}`
  if (tool.value === 'furniture') return `furniture:${furnitureKind.value}`
  return null
})

function grabItem(e: PointerEvent, item: LibraryItem) {
  // A drag that ended on the plan sent no click to clear this, so each press starts afresh.
  suppressClick = false
  chip = { item, x: e.clientX, y: e.clientY, moved: false }
  window.addEventListener('pointermove', chipMove)
  window.addEventListener('pointerup', chipUp, { once: true })
}

function chipMove(e: PointerEvent) {
  if (!chip) return
  if (!chip.moved && Math.hypot(e.clientX - chip.x, e.clientY - chip.y) > 6) chip.moved = true
  if (chip.moved) ghost.value = { name: itemName(chip.item), x: e.clientX, y: e.clientY }
}

function chipUp(e: PointerEvent) {
  window.removeEventListener('pointermove', chipMove)
  const c = chip
  chip = null
  ghost.value = null
  if (!c?.moved) return
  suppressClick = true
  const rect = svgEl.value?.getBoundingClientRect()
  if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
    dropItem(c.item, toGrid(e))
    settle()
  }
}

/** Put a Library item down where it was dropped. */
function dropItem(item: LibraryItem, p: { x: number; y: number }) {
  if (item.type === 'device') return placeAt(item.ref, p)
  if (item.type === 'furniture') {
    const pw = props.plan.plot.w
    const ph = props.plan.plot.h
    const at = { x: clamp(Math.round(p.x * 2) / 2, 0, pw), y: clamp(Math.round(p.y * 2) / 2, 0, ph) }
    const f = addFurniture(props.plan, floor.value, item.kind, at)
    clearSelection()
    selFurniture.value = f.id
    return
  }
  const u = nearestWall(floor.value, p.x, p.y)
  if (!u) return toast.warning(`Drop the ${item.preset.label.toLowerCase()} on a wall.`)
  if (openingAt(floor.value, u)) return toast.warning('There is already a door or window there.')
  const o = addOpening(floor.value, u, item.preset)
  if (!o) return toast.warning(`There is no room for the ${item.preset.label.toLowerCase()} there.`)
  clearSelection()
  selOpening.value = o.id
}

/** A tap on a Library item: the next tap on the plan puts it down. */
function pickItem(item: LibraryItem) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (item.type === 'device') {
    const on = armed.value === item.ref
    setTool('select')
    armed.value = on ? null : item.ref
  } else if (item.type === 'furniture') {
    setTool('furniture')
    furnitureKind.value = item.kind
  } else {
    setTool(item.preset.kind)
    if (item.preset.kind === 'door') doorPreset.value = item.preset.id
    else windowPreset.value = item.preset.id
  }
}

// ─── The inspector's tabs ───────────────────────────────────────────────────

const SIDE_TABS = [
  { id: 'properties', label: 'Properties' },
  { id: 'library', label: 'Library' },
  { id: 'house', label: 'House' },
]
const sideTab = ref('properties')

/** What is selected, as the outline names it. Nothing selected is the floor. */
const outlineSelected = computed(() => {
  const f = floorId.value
  if (selRoom.value) return outlineId('room', f, selRoom.value)
  if (selRef.value) return outlineId('device', f, selRef.value)
  if (selOpening.value) return outlineId('opening', f, selOpening.value)
  if (selRadiator.value) return outlineId('radiator', f, selRadiator.value)
  if (selFurniture.value) return outlineId('furniture', f, selFurniture.value)
  return outlineId('floor', f, f)
})

function pickOutline(p: OutlinePick) {
  floorId.value = p.floor
  clearSelection()
  armed.value = null
  if (p.type === 'room') selRoom.value = p.id
  else if (p.type === 'device') selRef.value = p.id
  else if (p.type === 'opening') selOpening.value = p.id
  else if (p.type === 'radiator') selRadiator.value = p.id
  else if (p.type === 'furniture') selFurniture.value = p.id
  if (p.type !== 'floor') tool.value = 'select'
}

// The Door, Window and Furniture tools put down what is picked in the
// Library, so picking one of them shows it. Something new on the plan, put
// there from the Library, shows its properties.
watch(tool, (t) => {
  if (t === 'door' || t === 'window' || t === 'furniture') sideTab.value = 'library'
})
watch(outlineSelected, () => {
  if (sideTab.value === 'library' && !outlineSelected.value.startsWith('floor:')) sideTab.value = 'properties'
})

// ─── The 3D preview ─────────────────────────────────────────────────────────
// The stage draws from a plan it is handed whole, and the editor edits its
// draft in place, so the preview gets a copy, taken a moment after the last
// change so a drag does not copy the plan on every pointer move.

/** A plain copy. The plan is JSON, and an edit can leave a reactive object in it that structuredClone refuses. */
const copyPlan = (): HousePlan => JSON.parse(JSON.stringify(props.plan))
const previewPlan = shallowRef<HousePlan>(copyPlan())
let previewTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.plan,
  () => {
    if (phone.value) return
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => (previewPlan.value = copyPlan()), 150)
  },
  { deep: true },
)
onBeforeUnmount(() => clearTimeout(previewTimer))

// ─── Undo and redo ──────────────────────────────────────────────────────────
// A step is the plan once a change has settled: a drag counts when it ends,
// and typing in a field when it pauses, so neither is a step per key or per
// pointer move.

const history = new History(JSON.stringify(props.plan))
const canUndo = ref(false)
const canRedo = ref(false)
let historyTimer: ReturnType<typeof setTimeout> | undefined
const busy = () => !!drag || !!chip || panning.value || !!pinch

function settle() {
  clearTimeout(historyTimer)
  historyTimer = undefined
  history.record(JSON.stringify(props.plan))
  canUndo.value = history.canUndo
  canRedo.value = history.canRedo
}
function settleLater() {
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => (busy() ? settleLater() : settle()), 400)
}
watch(() => props.plan, settleLater, { deep: true })
onBeforeUnmount(() => clearTimeout(historyTimer))

function restore(state: string | null) {
  if (state === null) return
  drag = null
  draft.value = null
  replacePlan(props.plan, JSON.parse(state))
  // What was selected may not be there any more.
  if (!props.plan.floors.some((f) => f.id === floorId.value)) floorId.value = topFloor().id
  if (selRoom.value && !room.value) selRoom.value = null
  if (selOpening.value && !opening.value) selOpening.value = null
  if (selRadiator.value && !radiator.value) selRadiator.value = null
  if (selFurniture.value && !piece.value) selFurniture.value = null
  if (selRef.value && !placed.value) selRef.value = null
  canUndo.value = history.canUndo
  canRedo.value = history.canRedo
}
function undo() {
  if (busy()) return
  // A change still settling is a step of its own, undone first.
  if (historyTimer) settle()
  restore(history.undo())
}
function redo() {
  if (busy()) return
  if (historyTimer) settle()
  restore(history.redo())
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measureUnit()
  observer = new ResizeObserver(() => {
    const box = canvasEl.value?.getBoundingClientRect()
    if (box) canvasSize.value = { w: box.width, h: box.height }
    measureUnit()
  })
  if (canvasEl.value) observer.observe(canvasEl.value)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  // Start where the person can act: drawing on an empty plan, selecting on one with rooms.
  if (props.plan.floors.some((f) => f.rooms.length)) tool.value = 'select'
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointermove', chipMove)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})
watch(viewBox, () => nextTick(measureUnit))
</script>

<style lang="scss" scoped>
// The rulers' thickness, as RULER_SIZE in house/ruler.ts.
$ruler: 20px;

.house-editor {
  // The blueprint is the page: it fills the content area edge to edge, with
  // the tools floating over it.
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  // On a phone the panels sit under the blueprint, and the page scrolls.
  // Its own height, not the screen's: squeezed to the screen, the blueprint
  // overflowed its row and the panels under it were drawn over it.
  &.is-phone {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--nb-spacing-16);
    flex: none;
  }
}

.house-editor__main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  .is-phone & {
    display: block;
    min-height: auto;
  }
}

.house-editor__tools {
  display: flex;
  gap: var(--nb-spacing-2);
  // Concentric with the pill buttons inside, as the view's own panels are.
  padding: var(--nb-overlay-inset, var(--nb-spacing-4));
  border-radius: calc(var(--nb-field-height-sm) / 2 + var(--nb-overlay-inset, var(--nb-spacing-4)));
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  // A row of tools wider than a phone scrolls sideways, not the page.
  .is-phone & {
    max-width: 100%;
    overflow-x: auto;
    box-sizing: border-box;
  }
}
.house-editor__kind {
  width: 10rem;
}
.house-editor__toolbar {
  position: absolute;
  z-index: 1;
  // Inside the rulers.
  top: calc(var(--nb-spacing-12) + #{$ruler});
  left: calc(var(--nb-spacing-12) + #{$ruler});
  right: var(--nb-spacing-12);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--nb-spacing-8);
  pointer-events: none;

  > * {
    pointer-events: auto;
  }

  .is-phone & {
    position: static;
    margin-bottom: var(--nb-spacing-8);
  }

  // A tab bar fills its row by default. Here several sit side by side.
  > :deep(.nb-tabs) {
    width: auto;
    max-width: 100%;
  }
}

.house-editor__canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;

  .is-phone & {
    max-height: 74vh;

    border-radius: var(--nb-radius-md);
    border: 1px solid var(--nb-c-border);
  }
}

.house-editor__svg {
  width: 100%;
  height: 100%;
  display: block;
  // It fills the canvas. The room for the rulers, the toolbar and the hint
  // is in the fitted view (see home), so a zoomed plan runs to every edge.
  touch-action: none;
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;

  &.hv-tool-select {
    cursor: default;
  }
  &.is-panning {
    cursor: grab;
  }
}

.house-editor__ruler {
  position: absolute;
  z-index: 1;
}
.house-editor__ruler--x {
  top: 0;
  left: $ruler;
}
.house-editor__ruler--y {
  top: $ruler;
  left: 0;
}
.house-editor__ruler-corner {
  position: absolute;
  z-index: 1;
  top: 0;
  left: 0;
  width: $ruler;
  height: $ruler;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  background: var(--nb-c-layer-1);
  border-right: 1px solid var(--nb-c-border);
  border-bottom: 1px solid var(--nb-c-border);
  color: var(--nb-c-text-muted);
  font-family: var(--nb-font-family-mono);
  font-size: 9px;
  pointer-events: none;
}

// The floors, on the left inside the ruler, where the live view has them.
.house-editor__floors {
  left: calc(var(--nb-spacing-8) + #{$ruler});

  // On a phone the zoom row has the bottom, so the floors take the top left,
  // inside the rulers.
  &.is-phone {
    top: calc(var(--nb-spacing-8) + #{$ruler});
    bottom: auto;
  }
}

.house-editor__zoom {
  position: absolute;
  z-index: 1;
  right: var(--nb-spacing-8);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--nb-spacing-2);
  // Concentric with the pill buttons inside, as the view's own panels are.
  padding: var(--nb-overlay-inset, var(--nb-spacing-4));
  border-radius: calc(var(--nb-field-height-sm) / 2 + var(--nb-overlay-inset, var(--nb-spacing-4)));
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  .is-phone & {
    top: auto;
    bottom: var(--nb-spacing-8);
    transform: none;
    flex-direction: row;
  }
}
.house-editor__zoom-level {
  min-width: 3.2em;
  padding: var(--nb-spacing-2) 0;
  text-align: center;
  color: var(--nb-c-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.house-editor__help {
  position: absolute;
  left: calc(var(--nb-spacing-12) + #{$ruler});
  bottom: var(--nb-spacing-12);
  max-width: min(640px, calc(100% - 24px));
  // On a page surface, so it reads on the blueprint in light and dark.
  padding: var(--nb-spacing-4) var(--nb-spacing-12);
  border-radius: var(--nb-radius-control);
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  .is-phone & {
    position: static;
    margin-top: var(--nb-spacing-8);
    padding: 0;
    background: none;
    border: 0;
  }
}

.house-editor__side {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
  min-width: 0;

  :deep(.nb-field) {
    margin-bottom: var(--nb-spacing-8);
  }
}

.house-editor__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-spacing-8);
  margin-top: var(--nb-spacing-8);
}

.house-editor__row--tight {
  margin-top: 0;
}

.house-editor__row--end {
  align-items: flex-end;

  :deep(.nb-field) {
    margin-bottom: 0;
  }
}

// Two short fields side by side: frame and colour, sill and head.
// Read out, not shown: the toolbar selects' names.
.house-editor__preview {
  height: 220px;
  flex: none;
}

.house-editor__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.house-editor__pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--nb-spacing-8);
}

// One covering: what it is and where, then what drives it.
.house-editor__covering {
  padding-bottom: var(--nb-spacing-8);
  margin-bottom: var(--nb-spacing-8);
  border-bottom: 1px solid var(--nb-c-border);
}

.house-editor__grow {
  flex: 1;
  min-width: 0;
}

.house-editor__muted {
  color: var(--nb-c-text-muted);
  margin: 0 0 var(--nb-spacing-8);
}

.house-editor__checks {
  display: grid;
  gap: var(--nb-spacing-4);
}

.house-editor__tray {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-8);
}

.house-editor__chip {
  touch-action: none;
}

.house-editor__ghost {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  transform: translate(-50%, -50%);
  padding: var(--nb-spacing-4) var(--nb-spacing-8);
  border-radius: var(--nb-radius-control);
  background: var(--nb-c-primary);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
</style>
