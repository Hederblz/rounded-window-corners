import { global, log } from '@global'

import { Bin }                  from 'gi://St'
import { Point }                from 'gi://Graphene'
import { BindingFlags,  }       from 'gi://GObject'
import { Window, WindowActor }  from 'gi://Meta'
import { actor_box_alloc, BindConstraint, BindCoordinate, Clone, Color } from 'gi://Clutter'

import { Workspace }      from '@imports/ui/workspace'
import { WindowPreview }  from '@imports/ui/windowPreview'
import { WorkspaceGroup } from '@imports/ui/workspaceAnimation'

import GrayEffect         from './effect/gray_effect'
import Utils              from './utils.js'
import consts             from './consts'

import {
  RoundedCornersEffect,
  RoundedCornersEffectClass
} from './effect/rounded_corners_effect'

export class Extension {
  private _origAddWindowClone!: (_: Window) => WindowPreview
  private _origCreateWindows!:  () => void
  private _maps: Map<Window, Bin> = new Map()

  private map_handler     !: number
  private restack_handler !: number

  constructor() {
    log(consts.LOADED_MSG)
  }

  enable() {
    this._origAddWindowClone  = Workspace.prototype._addWindowClone
    this._origCreateWindows   = WorkspaceGroup.prototype._createWindows

    const extensionThis = this

    // Overview
    Workspace.prototype._addWindowClone = function(meta_window) {
      const clone: WindowPreview =
        extensionThis._origAddWindowClone.apply(this, [meta_window])
      const window_container = clone.window_container

      const source = extensionThis._maps.get(meta_window)

      if (!source) {
        return clone
      }

      const shadowActor = new Clone({
        source,
        pivot_point: new Point({ x: 0.5, y: 0.5 })
      })
      log(`shadow of window ${meta_window} => ` +
           `${extensionThis._maps.get(meta_window)}`)

      window_container.bind_property('size', shadowActor, 'size', 0)
      window_container.bind_property('scale-x', shadowActor, 'scale-x', 0)
      window_container.bind_property('scale-y', shadowActor, 'scale-y', 0)

      clone.insert_child_above(shadowActor, window_container)

      shadowActor.connect('destroy', () =>
        log('Switching ws' + shadowActor + 'has destroy')
      )

      return clone
    }

    // Switching workspace
    WorkspaceGroup.prototype._createWindows = function() {
      extensionThis._origCreateWindows.apply(this)

      this._windowRecords.forEach(({ windowActor, clone }) => {
        const metaWindow = windowActor.metaWindow

        if (!extensionThis._maps.get(metaWindow)) {
          return
        }

        const shadowActor = new Clone({
          source: extensionThis._maps.get(metaWindow)
        })

        log(`shadow of window ${metaWindow} => ` +
             `${extensionThis._maps.get(metaWindow)}`)

        const frameRect = metaWindow.get_frame_rect()
        shadowActor.width = frameRect.width
        shadowActor.height = frameRect.height
        shadowActor.x = clone.x + frameRect.x - windowActor.x
        shadowActor.y = clone.y + frameRect.y - windowActor.y

        clone.connect(
          'notify::translation-z',
          () => shadowActor.translation_z = clone.translation_z + 0.003
        )

        shadowActor.connect('destroy', () =>
          log('Switching ws' + shadowActor + 'has destroy')
        )

        this.insert_child_above(shadowActor, clone)
      })
      log(this._windowRecords)
    }

    // Try to change order of shadow actor when windows are
    // restacked.
    this.restack_handler = global.display.connect('restacked', () => {
      global.get_window_actors().forEach(actor => {
        if (!actor.visible) {
          return
        }
        const shadow = this._maps.get(actor.metaWindow)
        if (shadow) {
          global.windowGroup.set_child_above_sibling(shadow, actor)
        }
      })
    })

    // Add Rounded Effect to window when it have been added
    this.map_handler = global.window_manager.connect('map',
      (_, window_actor) => {
        // window_actor.add_effect(new GrayEffect())
        window_actor.first_child.add_effect_with_name(
          consts.WINDOW_ROUNED_CORERS_EFFECT,
          new RoundedCornersEffect()
        )

        log('[MetaWindow] ', window_actor.meta_window.get_wm_class())
        log('[MetaWindow] ', Utils.AppType[Utils.getAppType(window_actor.meta_window)])

        const shadow_actor = new Bin()
        shadow_actor.style =
        `background: rgba(${Math.random()},
          ${Math.random()}, ${Math.random()}, 0.0);`

        const flag = BindingFlags.SYNC_CREATE

        for (const prop of [
          'pivot-point', 'visible', 'opacity','scale-x',
          'scale-y', 'translation-x', 'translation-y',
        ]) {
          window_actor.bind_property(prop, shadow_actor, prop, flag)
        }

        this.bindShadowActorConstraint(window_actor, shadow_actor)

        window_actor.connect('destroy', () => {
          shadow_actor.destroy()
          this._maps.delete(window_actor.metaWindow)
        })

        window_actor.get_parent()
          ?.insert_child_below(shadow_actor, window_actor)

        this._maps.set(window_actor.metaWindow, shadow_actor)
      }
    )
  }

  disable() {
    Workspace.prototype._addWindowClone = this._origAddWindowClone
    WorkspaceGroup.prototype._createWindows = this._origCreateWindows
    global.window_manager.disconnect(this.map_handler)
    global.display.disconnect(this.restack_handler)
  }

  // https://github.com/aunetx/blur-my-shell/blob/master/src/components/applications.js#L346
  private bindShadowActorConstraint(win: WindowActor, shadow: Bin) {
    const offsets = Utils.computeOffset(win.metaWindow)

    shadow.add_constraint(new BindConstraint({
      source:     win,
      coordinate: BindCoordinate.X,
      offset:     offsets[0]
    }))
    shadow.add_constraint(new BindConstraint({
      source:     win,
      coordinate: BindCoordinate.Y,
      offset:     offsets[1]
    }))
    shadow.add_constraint(new BindConstraint({
      source:     win,
      coordinate: BindCoordinate.WIDTH,
      offset:     offsets[2]
    }))
    shadow.add_constraint(new BindConstraint({
      source:     win,
      coordinate: BindCoordinate.HEIGHT,
      offset:     offsets[3]
    }))

    win.metaWindow.connect('size-changed', (win) => {
      const offsets = Utils.computeOffset(win)
      const constraints = shadow.get_constraints()
      constraints.forEach((constraint, i) => {
        if (constraint instanceof BindConstraint) {
          constraint.offset = offsets[i]
        }
      })
      const e = (win.get_compositor_private() as WindowActor).get_effect(
        consts.WINDOW_ROUNED_CORERS_EFFECT
      );
      (e as RoundedCornersEffectClass)?.update_uniforms()
    })
  }
}
