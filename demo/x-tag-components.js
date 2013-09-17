// We don't use the platform bootstrapper, so fake this stuff.

window.Platform = {};
var logFlags = {};



// DOMTokenList polyfill fir IE9
(function () {

if (typeof window.Element === "undefined" || "classList" in document.documentElement) return;

var prototype = Array.prototype,
    indexOf = prototype.indexOf,
    slice = prototype.slice,
    push = prototype.push,
    splice = prototype.splice,
    join = prototype.join;

function DOMTokenList(el) {
  this._element = el;
  if (el.className != this._classCache) {
    this._classCache = el.className;

    if (!this._classCache) return;

      // The className needs to be trimmed and split on whitespace
      // to retrieve a list of classes.
      var classes = this._classCache.replace(/^\s+|\s+$/g,'').split(/\s+/),
        i;
    for (i = 0; i < classes.length; i++) {
      push.call(this, classes[i]);
    }
  }
};

function setToClassName(el, classes) {
  el.className = classes.join(' ');
}

DOMTokenList.prototype = {
  add: function(token) {
    if(this.contains(token)) return;
    push.call(this, token);
    setToClassName(this._element, slice.call(this, 0));
  },
  contains: function(token) {
    return indexOf.call(this, token) !== -1;
  },
  item: function(index) {
    return this[index] || null;
  },
  remove: function(token) {
    var i = indexOf.call(this, token);
     if (i === -1) {
       return;
     }
    splice.call(this, i, 1);
    setToClassName(this._element, slice.call(this, 0));
  },
  toString: function() {
    return join.call(this, ' ');
  },
  toggle: function(token) {
    if (indexOf.call(this, token) === -1) {
      this.add(token);
    } else {
      this.remove(token);
    }
  }
};

window.DOMTokenList = DOMTokenList;

function defineElementGetter (obj, prop, getter) {
  if (Object.defineProperty) {
    Object.defineProperty(obj, prop,{
      get : getter
    })
  } else {
    obj.__defineGetter__(prop, getter);
  }
}

defineElementGetter(Element.prototype, 'classList', function () {
  return new DOMTokenList(this);
});

})();


/*
 * Copyright 2012 The Polymer Authors. All rights reserved.
 * Use of this source code is goverened by a BSD-style
 * license that can be found in the LICENSE file.
 */

// SideTable is a weak map where possible. If WeakMap is not available the
// association is stored as an expando property.
var SideTable;
// TODO(arv): WeakMap does not allow for Node etc to be keys in Firefox
if (typeof WeakMap !== 'undefined' && navigator.userAgent.indexOf('Firefox/') < 0) {
  SideTable = WeakMap;
} else {
  (function() {
    var defineProperty = Object.defineProperty;
    var counter = Date.now() % 1e9;

    SideTable = function() {
      this.name = '__st' + (Math.random() * 1e9 >>> 0) + (counter++ + '__');
    };

    SideTable.prototype = {
      set: function(key, value) {
        var entry = key[this.name];
        if (entry && entry[0] === key)
          entry[1] = value;
        else
          defineProperty(key, this.name, {value: [key, value], writable: true});
      },
      get: function(key) {
        var entry;
        return (entry = key[this.name]) && entry[0] === key ?
            entry[1] : undefined;
      },
      delete: function(key) {
        this.set(key, undefined);
      }
    }
  })();
}

/*
 * Copyright 2012 The Polymer Authors. All rights reserved.
 * Use of this source code is goverened by a BSD-style
 * license that can be found in the LICENSE file.
 */

(function(global) {

  var registrationsTable = new SideTable();

  // We use setImmediate or postMessage for our future callback.
  var setImmediate = window.msSetImmediate;

  // Use post message to emulate setImmediate.
  if (!setImmediate) {
    var setImmediateQueue = [];
    var sentinel = String(Math.random());
    window.addEventListener('message', function(e) {
      if (e.data === sentinel) {
        var queue = setImmediateQueue;
        setImmediateQueue = [];
        queue.forEach(function(func) {
          func();
        });
      }
    });
    setImmediate = function(func) {
      setImmediateQueue.push(func);
      window.postMessage(sentinel, '*');
    };
  }

  // This is used to ensure that we never schedule 2 callas to setImmediate
  var isScheduled = false;

  // Keep track of observers that needs to be notified next time.
  var scheduledObservers = [];

  /**
   * Schedules |dispatchCallback| to be called in the future.
   * @param {MutationObserver} observer
   */
  function scheduleCallback(observer) {
    scheduledObservers.push(observer);
    if (!isScheduled) {
      isScheduled = true;
      setImmediate(dispatchCallbacks);
    }
  }

  function wrapIfNeeded(node) {
    return window.ShadowDOMPolyfill &&
        window.ShadowDOMPolyfill.wrapIfNeeded(node) ||
        node;
  }

  function dispatchCallbacks() {
    // http://dom.spec.whatwg.org/#mutation-observers

    isScheduled = false; // Used to allow a new setImmediate call above.

    var observers = scheduledObservers;
    scheduledObservers = [];
    // Sort observers based on their creation UID (incremental).
    observers.sort(function(o1, o2) {
      return o1.uid_ - o2.uid_;
    });

    var anyNonEmpty = false;
    observers.forEach(function(observer) {

      // 2.1, 2.2
      var queue = observer.takeRecords();
      // 2.3. Remove all transient registered observers whose observer is mo.
      removeTransientObserversFor(observer);

      // 2.4
      if (queue.length) {
        observer.callback_(queue, observer);
        anyNonEmpty = true;
      }
    });

    // 3.
    if (anyNonEmpty)
      dispatchCallbacks();
  }

  function removeTransientObserversFor(observer) {
    observer.nodes_.forEach(function(node) {
      var registrations = registrationsTable.get(node);
      if (!registrations)
        return;
      registrations.forEach(function(registration) {
        if (registration.observer === observer)
          registration.removeTransientObservers();
      });
    });
  }

  /**
   * This function is used for the "For each registered observer observer (with
   * observer's options as options) in target's list of registered observers,
   * run these substeps:" and the "For each ancestor ancestor of target, and for
   * each registered observer observer (with options options) in ancestor's list
   * of registered observers, run these substeps:" part of the algorithms. The
   * |options.subtree| is checked to ensure that the callback is called
   * correctly.
   *
   * @param {Node} target
   * @param {function(MutationObserverInit):MutationRecord} callback
   */
  function forEachAncestorAndObserverEnqueueRecord(target, callback) {
    for (var node = target; node; node = node.parentNode) {
      var registrations = registrationsTable.get(node);

      if (registrations) {
        for (var j = 0; j < registrations.length; j++) {
          var registration = registrations[j];
          var options = registration.options;

          // Only target ignores subtree.
          if (node !== target && !options.subtree)
            continue;

          var record = callback(options);
          if (record)
            registration.enqueue(record);
        }
      }
    }
  }

  var uidCounter = 0;

  /**
   * The class that maps to the DOM MutationObserver interface.
   * @param {Function} callback.
   * @constructor
   */
  function JsMutationObserver(callback) {
    this.callback_ = callback;
    this.nodes_ = [];
    this.records_ = [];
    this.uid_ = ++uidCounter;
  }

  JsMutationObserver.prototype = {
    observe: function(target, options) {
      target = wrapIfNeeded(target);

      // 1.1
      if (!options.childList && !options.attributes && !options.characterData ||

          // 1.2
          options.attributeOldValue && !options.attributes ||

          // 1.3
          options.attributeFilter && options.attributeFilter.length &&
              !options.attributes ||

          // 1.4
          options.characterDataOldValue && !options.characterData) {

        throw new SyntaxError();
      }

      var registrations = registrationsTable.get(target);
      if (!registrations)
        registrationsTable.set(target, registrations = []);

      // 2
      // If target's list of registered observers already includes a registered
      // observer associated with the context object, replace that registered
      // observer's options with options.
      var registration;
      for (var i = 0; i < registrations.length; i++) {
        if (registrations[i].observer === this) {
          registration = registrations[i];
          registration.removeListeners();
          registration.options = options;
          break;
        }
      }

      // 3.
      // Otherwise, add a new registered observer to target's list of registered
      // observers with the context object as the observer and options as the
      // options, and add target to context object's list of nodes on which it
      // is registered.
      if (!registration) {
        registration = new Registration(this, target, options);
        registrations.push(registration);
        this.nodes_.push(target);
      }

      registration.addListeners();
    },

    disconnect: function() {
      this.nodes_.forEach(function(node) {
        var registrations = registrationsTable.get(node);
        for (var i = 0; i < registrations.length; i++) {
          var registration = registrations[i];
          if (registration.observer === this) {
            registration.removeListeners();
            registrations.splice(i, 1);
            // Each node can only have one registered observer associated with
            // this observer.
            break;
          }
        }
      }, this);
      this.records_ = [];
    },

    takeRecords: function() {
      var copyOfRecords = this.records_;
      this.records_ = [];
      return copyOfRecords;
    }
  };

  /**
   * @param {string} type
   * @param {Node} target
   * @constructor
   */
  function MutationRecord(type, target) {
    this.type = type;
    this.target = target;
    this.addedNodes = [];
    this.removedNodes = [];
    this.previousSibling = null;
    this.nextSibling = null;
    this.attributeName = null;
    this.attributeNamespace = null;
    this.oldValue = null;
  }

  function copyMutationRecord(original) {
    var record = new MutationRecord(original.type, original.target);
    record.addedNodes = original.addedNodes.slice();
    record.removedNodes = original.removedNodes.slice();
    record.previousSibling = original.previousSibling;
    record.nextSibling = original.nextSibling;
    record.attributeName = original.attributeName;
    record.attributeNamespace = original.attributeNamespace;
    record.oldValue = original.oldValue;
    return record;
  };

  // We keep track of the two (possibly one) records used in a single mutation.
  var currentRecord, recordWithOldValue;

  /**
   * Creates a record without |oldValue| and caches it as |currentRecord| for
   * later use.
   * @param {string} oldValue
   * @return {MutationRecord}
   */
  function getRecord(type, target) {
    return currentRecord = new MutationRecord(type, target);
  }

  /**
   * Gets or creates a record with |oldValue| based in the |currentRecord|
   * @param {string} oldValue
   * @return {MutationRecord}
   */
  function getRecordWithOldValue(oldValue) {
    if (recordWithOldValue)
      return recordWithOldValue;
    recordWithOldValue = copyMutationRecord(currentRecord);
    recordWithOldValue.oldValue = oldValue;
    return recordWithOldValue;
  }

  function clearRecords() {
    currentRecord = recordWithOldValue = undefined;
  }

  /**
   * @param {MutationRecord} record
   * @return {boolean} Whether the record represents a record from the current
   * mutation event.
   */
  function recordRepresentsCurrentMutation(record) {
    return record === recordWithOldValue || record === currentRecord;
  }

  /**
   * Selects which record, if any, to replace the last record in the queue.
   * This returns |null| if no record should be replaced.
   *
   * @param {MutationRecord} lastRecord
   * @param {MutationRecord} newRecord
   * @param {MutationRecord}
   */
  function selectRecord(lastRecord, newRecord) {
    if (lastRecord === newRecord)
      return lastRecord;

    // Check if the the record we are adding represents the same record. If
    // so, we keep the one with the oldValue in it.
    if (recordWithOldValue && recordRepresentsCurrentMutation(lastRecord))
      return recordWithOldValue;

    return null;
  }

  /**
   * Class used to represent a registered observer.
   * @param {MutationObserver} observer
   * @param {Node} target
   * @param {MutationObserverInit} options
   * @constructor
   */
  function Registration(observer, target, options) {
    this.observer = observer;
    this.target = target;
    this.options = options;
    this.transientObservedNodes = [];
  }

  Registration.prototype = {
    enqueue: function(record) {
      var records = this.observer.records_;
      var length = records.length;

      // There are cases where we replace the last record with the new record.
      // For example if the record represents the same mutation we need to use
      // the one with the oldValue. If we get same record (this can happen as we
      // walk up the tree) we ignore the new record.
      if (records.length > 0) {
        var lastRecord = records[length - 1];
        var recordToReplaceLast = selectRecord(lastRecord, record);
        if (recordToReplaceLast) {
          records[length - 1] = recordToReplaceLast;
          return;
        }
      } else {
        scheduleCallback(this.observer);
      }

      records[length] = record;
    },

    addListeners: function() {
      this.addListeners_(this.target);
    },

    addListeners_: function(node) {
      var options = this.options;
      if (options.attributes)
        node.addEventListener('DOMAttrModified', this, true);

      if (options.characterData)
        node.addEventListener('DOMCharacterDataModified', this, true);

      if (options.childList)
        node.addEventListener('DOMNodeInserted', this, true);

      if (options.childList || options.subtree)
        node.addEventListener('DOMNodeRemoved', this, true);
    },

    removeListeners: function() {
      this.removeListeners_(this.target);
    },

    removeListeners_: function(node) {
      var options = this.options;
      if (options.attributes)
        node.removeEventListener('DOMAttrModified', this, true);

      if (options.characterData)
        node.removeEventListener('DOMCharacterDataModified', this, true);

      if (options.childList)
        node.removeEventListener('DOMNodeInserted', this, true);

      if (options.childList || options.subtree)
        node.removeEventListener('DOMNodeRemoved', this, true);
    },

    /**
     * Adds a transient observer on node. The transient observer gets removed
     * next time we deliver the change records.
     * @param {Node} node
     */
    addTransientObserver: function(node) {
      // Don't add transient observers on the target itself. We already have all
      // the required listeners set up on the target.
      if (node === this.target)
        return;

      this.addListeners_(node);
      this.transientObservedNodes.push(node);
      var registrations = registrationsTable.get(node);
      if (!registrations)
        registrationsTable.set(node, registrations = []);

      // We know that registrations does not contain this because we already
      // checked if node === this.target.
      registrations.push(this);
    },

    removeTransientObservers: function() {
      var transientObservedNodes = this.transientObservedNodes;
      this.transientObservedNodes = [];

      transientObservedNodes.forEach(function(node) {
        // Transient observers are never added to the target.
        this.removeListeners_(node);

        var registrations = registrationsTable.get(node);
        for (var i = 0; i < registrations.length; i++) {
          if (registrations[i] === this) {
            registrations.splice(i, 1);
            // Each node can only have one registered observer associated with
            // this observer.
            break;
          }
        }
      }, this);
    },

    handleEvent: function(e) {
      // Stop propagation since we are managing the propagation manually.
      // This means that other mutation events on the page will not work
      // correctly but that is by design.
      e.stopImmediatePropagation();

      switch (e.type) {
        case 'DOMAttrModified':
          // http://dom.spec.whatwg.org/#concept-mo-queue-attributes

          var name = e.attrName;
          var namespace = e.relatedNode.namespaceURI;
          var target = e.target;

          // 1.
          var record = new getRecord('attributes', target);
          record.attributeName = name;
          record.attributeNamespace = namespace;

          // 2.
          var oldValue =
              e.attrChange === MutationEvent.ADDITION ? null : e.prevValue;

          forEachAncestorAndObserverEnqueueRecord(target, function(options) {
            // 3.1, 4.2
            if (!options.attributes)
              return;

            // 3.2, 4.3
            if (options.attributeFilter && options.attributeFilter.length &&
                options.attributeFilter.indexOf(name) === -1 &&
                options.attributeFilter.indexOf(namespace) === -1) {
              return;
            }
            // 3.3, 4.4
            if (options.attributeOldValue)
              return getRecordWithOldValue(oldValue);

            // 3.4, 4.5
            return record;
          });

          break;

        case 'DOMCharacterDataModified':
          // http://dom.spec.whatwg.org/#concept-mo-queue-characterdata
          var target = e.target;

          // 1.
          var record = getRecord('characterData', target);

          // 2.
          var oldValue = e.prevValue;


          forEachAncestorAndObserverEnqueueRecord(target, function(options) {
            // 3.1, 4.2
            if (!options.characterData)
              return;

            // 3.2, 4.3
            if (options.characterDataOldValue)
              return getRecordWithOldValue(oldValue);

            // 3.3, 4.4
            return record;
          });

          break;

        case 'DOMNodeRemoved':
          this.addTransientObserver(e.target);
          // Fall through.
        case 'DOMNodeInserted':
          // http://dom.spec.whatwg.org/#concept-mo-queue-childlist
          var target = e.relatedNode;
          var changedNode = e.target;
          var addedNodes, removedNodes;
          if (e.type === 'DOMNodeInserted') {
            addedNodes = [changedNode];
            removedNodes = [];
          } else {

            addedNodes = [];
            removedNodes = [changedNode];
          }
          var previousSibling = changedNode.previousSibling;
          var nextSibling = changedNode.nextSibling;

          // 1.
          var record = getRecord('childList', target);
          record.addedNodes = addedNodes;
          record.removedNodes = removedNodes;
          record.previousSibling = previousSibling;
          record.nextSibling = nextSibling;

          forEachAncestorAndObserverEnqueueRecord(target, function(options) {
            // 2.1, 3.2
            if (!options.childList)
              return;

            // 2.2, 3.3
            return record;
          });

      }

      clearRecords();
    }
  };

  global.JsMutationObserver = JsMutationObserver;

})(this);

/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */

if (!window.MutationObserver) {
  window.MutationObserver = 
      window.WebKitMutationObserver || 
      window.JsMutationObserver;
  if (!MutationObserver) {
    throw new Error("no mutation observer support");
  }
}

/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */

/**
 * Implements `document.register`
 * @module CustomElements
*/

/**
 * Polyfilled extensions to the `document` object.
 * @class Document
*/

(function(scope) {

// imports

if (!scope) {
  scope = window.CustomElements = {flags:{}};
}
var flags = scope.flags;

// native document.register?

var hasNative = Boolean(document.webkitRegister || document.register);
var useNative = !flags.register && hasNative;

if (useNative) {

  // normalize
  document.register = document.register || document.webkitRegister;

  // stub
  var nop = function() {};

  // exports
  scope.registry = {};
  scope.upgradeElement = nop;
  
  scope.watchShadow = nop;
  scope.upgrade = nop;
  scope.upgradeAll = nop;
  scope.upgradeSubtree = nop;
  scope.observeDocument = nop;
  scope.upgradeDocument = nop;
  scope.takeRecords = nop;

} else {

  /**
   * Registers a custom tag name with the document.
   *
   * When a registered element is created, a `readyCallback` method is called
   * in the scope of the element. The `readyCallback` method can be specified on
   * either `options.prototype` or `options.lifecycle` with the latter taking
   * precedence.
   *
   * @method register
   * @param {String} name The tag name to register. Must include a dash ('-'),
   *    for example 'x-component'.
   * @param {Object} options
   *    @param {String} [options.extends]
   *      (_off spec_) Tag name of an element to extend (or blank for a new
   *      element). This parameter is not part of the specification, but instead
   *      is a hint for the polyfill because the extendee is difficult to infer.
   *      Remember that the input prototype must chain to the extended element's
   *      prototype (or HTMLElement.prototype) regardless of the value of
   *      `extends`.
   *    @param {Object} options.prototype The prototype to use for the new
   *      element. The prototype must inherit from HTMLElement.
   *    @param {Object} [options.lifecycle]
   *      Callbacks that fire at important phases in the life of the custom
   *      element.
   *
   * @example
   *      FancyButton = document.register("fancy-button", {
   *        extends: 'button',
   *        prototype: Object.create(HTMLButtonElement.prototype, {
   *          readyCallback: {
   *            value: function() {
   *              console.log("a fancy-button was created",
   *            }
   *          }
   *        })
   *      });
   * @return {Function} Constructor for the newly registered type.
   */
  function register(name, options) {
    //console.warn('document.register("' + name + '", ', options, ')');
    // construct a defintion out of options
    // TODO(sjmiles): probably should clone options instead of mutating it
    var definition = options || {};
    if (!name) {
      // TODO(sjmiles): replace with more appropriate error (EricB can probably
      // offer guidance)
      throw new Error('document.register: first argument `name` must not be empty');
    }
    if (name.indexOf('-') < 0) {
      // TODO(sjmiles): replace with more appropriate error (EricB can probably
      // offer guidance)
      throw new Error('document.register: first argument `name` must contain a dash (\'-\'). Argument was \'' + String(name) + '\'.');
    }
    // record name
    definition.name = name;
    // must have a prototype, default to an extension of HTMLElement
    // TODO(sjmiles): probably should throw if no prototype, check spec
    if (!definition.prototype) {
      // TODO(sjmiles): replace with more appropriate error (EricB can probably
      // offer guidance)
      throw new Error('Options missing required prototype property');
    }
    // ensure a lifecycle object so we don't have to null test it
    definition.lifecycle = definition.lifecycle || {};
    // build a list of ancestral custom elements (for native base detection)
    // TODO(sjmiles): we used to need to store this, but current code only
    // uses it in 'resolveTagName': it should probably be inlined
    definition.ancestry = ancestry(definition.extends);
    // extensions of native specializations of HTMLElement require localName
    // to remain native, and use secondary 'is' specifier for extension type
    resolveTagName(definition);
    // some platforms require modifications to the user-supplied prototype
    // chain
    resolvePrototypeChain(definition);
    // overrides to implement attributeChanged callback
    overrideAttributeApi(definition.prototype);
    // 7.1.5: Register the DEFINITION with DOCUMENT
    registerDefinition(name, definition);
    // 7.1.7. Run custom element constructor generation algorithm with PROTOTYPE
    // 7.1.8. Return the output of the previous step.
    definition.ctor = generateConstructor(definition);
    definition.ctor.prototype = definition.prototype;
    // force our .constructor to be our actual constructor
    definition.prototype.constructor = definition.ctor;
    // if initial parsing is complete
    if (scope.ready) {
      // upgrade any pre-existing nodes of this type
      scope.upgradeAll(document);
    }
    return definition.ctor;
  }

  function ancestry(extnds) {
    var extendee = registry[extnds];
    if (extendee) {
      return ancestry(extendee.extends).concat([extendee]);
    }
    return [];
  }

  function resolveTagName(definition) {
    // if we are explicitly extending something, that thing is our
    // baseTag, unless it represents a custom component
    var baseTag = definition.extends;
    // if our ancestry includes custom components, we only have a
    // baseTag if one of them does
    for (var i=0, a; (a=definition.ancestry[i]); i++) {
      baseTag = a.is && a.tag;
    }
    // our tag is our baseTag, if it exists, and otherwise just our name
    definition.tag = baseTag || definition.name;
    if (baseTag) {
      // if there is a base tag, use secondary 'is' specifier
      definition.is = definition.name;
    }
  }

  function resolvePrototypeChain(definition) {
    // if we don't support __proto__ we need to locate the native level
    // prototype for precise mixing in
    if (!Object.__proto__) {
      // default prototype
      var nativePrototype = HTMLElement.prototype;
      // work out prototype when using type-extension
      if (definition.is) {
        var inst = document.createElement(definition.tag);
        nativePrototype = Object.getPrototypeOf(inst);
      }
      // ensure __proto__ reference is installed at each point on the prototype
      // chain.
      // NOTE: On platforms without __proto__, a mixin strategy is used instead
      // of prototype swizzling. In this case, this generated __proto__ provides
      // limited support for prototype traversal.
      var proto = definition.prototype, ancestor;
      while (proto && (proto !== nativePrototype)) {
        var ancestor = Object.getPrototypeOf(proto);
        proto.__proto__ = ancestor;
        proto = ancestor;
      }
    }
    // cache this in case of mixin
    definition.native = nativePrototype;
  }

  // SECTION 4

  function instantiate(definition) {
    // 4.a.1. Create a new object that implements PROTOTYPE
    // 4.a.2. Let ELEMENT by this new object
    //
    // the custom element instantiation algorithm must also ensure that the
    // output is a valid DOM element with the proper wrapper in place.
    //
    return upgrade(domCreateElement(definition.tag), definition);
  }

  function upgrade(element, definition) {
    // some definitions specify an 'is' attribute
    if (definition.is) {
      element.setAttribute('is', definition.is);
    }
    // make 'element' implement definition.prototype
    implement(element, definition);
    // flag as upgraded
    element.__upgraded__ = true;
    // there should never be a shadow root on element at this point
    // we require child nodes be upgraded before `created`
    scope.upgradeSubtree(element);
    // lifecycle management
    created(element);
    // OUTPUT
    return element;
  }

  function implement(element, definition) {
    // prototype swizzling is best
    if (Object.__proto__) {
      element.__proto__ = definition.prototype;
    } else {
      // where above we can re-acquire inPrototype via
      // getPrototypeOf(Element), we cannot do so when
      // we use mixin, so we install a magic reference
      customMixin(element, definition.prototype, definition.native);
      element.__proto__ = definition.prototype;
    }
  }

  function customMixin(inTarget, inSrc, inNative) {
    // TODO(sjmiles): 'used' allows us to only copy the 'youngest' version of
    // any property. This set should be precalculated. We also need to
    // consider this for supporting 'super'.
    var used = {};
    // start with inSrc
    var p = inSrc;
    // sometimes the default is HTMLUnknownElement.prototype instead of
    // HTMLElement.prototype, so we add a test
    // the idea is to avoid mixing in native prototypes, so adding
    // the second test is WLOG
    while (p !== inNative && p !== HTMLUnknownElement.prototype) {
      var keys = Object.getOwnPropertyNames(p);
      for (var i=0, k; k=keys[i]; i++) {
        if (!used[k]) {
          Object.defineProperty(inTarget, k,
              Object.getOwnPropertyDescriptor(p, k));
          used[k] = 1;
        }
      }
      p = Object.getPrototypeOf(p);
    }
  }

  function created(element) {
    // invoke createdCallback
    if (element.createdCallback) {
      element.createdCallback();
    }
  }

  // attribute watching

  function overrideAttributeApi(prototype) {
    // overrides to implement callbacks
    // TODO(sjmiles): should support access via .attributes NamedNodeMap
    // TODO(sjmiles): preserves user defined overrides, if any
    var setAttribute = prototype.setAttribute;
    prototype.setAttribute = function(name, value) {
      changeAttribute.call(this, name, value, setAttribute);
    }
    var removeAttribute = prototype.removeAttribute;
    prototype.removeAttribute = function(name, value) {
      changeAttribute.call(this, name, value, removeAttribute);
    }
  }

  function changeAttribute(name, value, operation) {
    var oldValue = this.getAttribute(name);
    operation.apply(this, arguments);
    if (this.attributeChangedCallback 
        && (this.getAttribute(name) !== oldValue)) {
      this.attributeChangedCallback(name, oldValue);
    }
  }

  // element registry (maps tag names to definitions)

  var registry = {};

  function registerDefinition(name, definition) {
    registry[name] = definition;
  }

  function generateConstructor(definition) {
    return function() {
      return instantiate(definition);
    };
  }

  function createElement(tag, typeExtension) {
    // TODO(sjmiles): ignore 'tag' when using 'typeExtension', we could
    // error check it, or perhaps there should only ever be one argument
    var definition = registry[typeExtension || tag];
    if (definition) {
      return new definition.ctor();
    }
    return domCreateElement(tag);
  }

  function upgradeElement(element) {
    if (!element.__upgraded__ && (element.nodeType === Node.ELEMENT_NODE)) {
      var type = element.getAttribute('is') || element.localName;
      var definition = registry[type];
      return definition && upgrade(element, definition);
    }
  }

  function cloneNode(deep) {
    // call original clone
    var n = domCloneNode.call(this, deep);
    // upgrade the element and subtree
    scope.upgradeAll(n);
    // return the clone
    return n;
  }
  // capture native createElement before we override it

  var domCreateElement = document.createElement.bind(document);

  // capture native cloneNode before we override it

  var domCloneNode = Node.prototype.cloneNode;

  // exports

  document.register = register;
  document.createElement = createElement; // override
  Node.prototype.cloneNode = cloneNode; // override

  scope.registry = registry;

  /**
   * Upgrade an element to a custom element. Upgrading an element
   * causes the custom prototype to be applied, an `is` attribute 
   * to be attached (as needed), and invocation of the `readyCallback`.
   * `upgrade` does nothing if the element is already upgraded, or
   * if it matches no registered custom tag name.
   *
   * @method ugprade
   * @param {Element} element The element to upgrade.
   * @return {Element} The upgraded element.
   */
  scope.upgrade = upgradeElement;
}

scope.hasNative = hasNative;
scope.useNative = useNative;

})(window.CustomElements);

 /*
Copyright 2013 The Polymer Authors. All rights reserved.
Use of this source code is governed by a BSD-style
license that can be found in the LICENSE file.
*/

(function(scope){

var logFlags = window.logFlags || {};

// walk the subtree rooted at node, applying 'find(element, data)' function 
// to each element
// if 'find' returns true for 'element', do not search element's subtree  
function findAll(node, find, data) {
  var e = node.firstElementChild;
  if (!e) {
    e = node.firstChild;
    while (e && e.nodeType !== Node.ELEMENT_NODE) {
      e = e.nextSibling;
    }
  }
  while (e) {
    if (find(e, data) !== true) {
      findAll(e, find, data);
    }
    e = e.nextElementSibling;
  }
  return null;
}

// walk all shadowRoots on a given node.
function forRoots(node, cb) {
  var root = node.webkitShadowRoot;
  while(root) {
    forSubtree(root, cb);
    root = root.olderShadowRoot;
  }
}

// walk the subtree rooted at node, including descent into shadow-roots, 
// applying 'cb' to each element
function forSubtree(node, cb) {
  //logFlags.dom && node.childNodes && node.childNodes.length && console.group('subTree: ', node);
  findAll(node, function(e) {
    if (cb(e)) {
      return true;
    }
    forRoots(e, cb);
  });
  forRoots(node, cb);
  //logFlags.dom && node.childNodes && node.childNodes.length && console.groupEnd();
}

// manage lifecycle on added node
function added(node) {
  if (upgrade(node)) {
    insertedNode(node);
    return true; 
  }
  inserted(node);
}

// manage lifecycle on added node's subtree only
function addedSubtree(node) {
  forSubtree(node, function(e) {
    if (added(e)) {
      return true; 
    }
  });
}

// manage lifecycle on added node and it's subtree
function addedNode(node) {
  return added(node) || addedSubtree(node);
}

// upgrade custom elements at node, if applicable
function upgrade(node) {
  if (!node.__upgraded__ && node.nodeType === Node.ELEMENT_NODE) {
    var type = node.getAttribute('is') || node.localName;
    var definition = scope.registry[type];
    if (definition) {
      logFlags.dom && console.group('upgrade:', node.localName);
      scope.upgrade(node);
      logFlags.dom && console.groupEnd();
      return true;
    }
  }
}

function insertedNode(node) {
  inserted(node);
  if (inDocument(node)) {
    forSubtree(node, function(e) {
      inserted(e);
    });
  }
}

// TODO(sjmiles): if there are descents into trees that can never have inDocument(*) true, fix this

function inserted(element) {
  // TODO(sjmiles): it's possible we were inserted and removed in the space
  // of one microtask, in which case we won't be 'inDocument' here
  // But there are other cases where we are testing for inserted without
  // specific knowledge of mutations, and must test 'inDocument' to determine
  // whether to call inserted
  // If we can factor these cases into separate code paths we can have
  // better diagnostics.
  // TODO(sjmiles): when logging, do work on all custom elements so we can
  // track behavior even when callbacks not defined
  //console.log('inserted: ', element.localName);
  if (element.enteredDocumentCallback || (element.__upgraded__ && logFlags.dom)) {
    logFlags.dom && console.group('inserted:', element.localName);
    if (inDocument(element)) {
      element.__inserted = (element.__inserted || 0) + 1;
      // if we are in a 'removed' state, bluntly adjust to an 'inserted' state
      if (element.__inserted < 1) {
        element.__inserted = 1;
      }
      // if we are 'over inserted', squelch the callback
      if (element.__inserted > 1) {
        logFlags.dom && console.warn('inserted:', element.localName,
          'insert/remove count:', element.__inserted)
      } else if (element.enteredDocumentCallback) {
        logFlags.dom && console.log('inserted:', element.localName);
        element.enteredDocumentCallback();
      }
    }
    logFlags.dom && console.groupEnd();
  }
}

function removedNode(node) {
  removed(node);
  forSubtree(node, function(e) {
    removed(e);
  });
}

function removed(element) {
  // TODO(sjmiles): temporary: do work on all custom elements so we can track
  // behavior even when callbacks not defined
  if (element.leftDocumentCallback || (element.__upgraded__ && logFlags.dom)) {
    logFlags.dom && console.log('removed:', element.localName);
    if (!inDocument(element)) {
      element.__inserted = (element.__inserted || 0) - 1;
      // if we are in a 'inserted' state, bluntly adjust to an 'removed' state
      if (element.__inserted > 0) {
        element.__inserted = 0;
      }
      // if we are 'over removed', squelch the callback
      if (element.__inserted < 0) {
        logFlags.dom && console.warn('removed:', element.localName,
            'insert/remove count:', element.__inserted)
      } else if (element.leftDocumentCallback) {
        element.leftDocumentCallback();
      }
    }
  }
}

function inDocument(element) {
  var p = element;
  while (p) {
    if (p == element.ownerDocument) {
      return true;
    }
    p = p.parentNode || p.host;
  }
}

function watchShadow(node) {
  if (node.webkitShadowRoot && !node.webkitShadowRoot.__watched) {
    logFlags.dom && console.log('watching shadow-root for: ', node.localName);
    // watch all unwatched roots...
    var root = node.webkitShadowRoot;
    while (root) {
      watchRoot(root);
      root = root.olderShadowRoot;
    }
  }
}

function watchRoot(root) {
  if (!root.__watched) {
    observe(root);
    root.__watched = true;
  }
}

function filter(inNode) {
  switch (inNode.localName) {
    case 'style':
    case 'script':
    case 'template':
    case undefined:
      return true;
  }
}

function handler(mutations) {
  //
  if (logFlags.dom) {
    var mx = mutations[0];
    if (mx && mx.type === 'childList' && mx.addedNodes) {
        if (mx.addedNodes) {
          var d = mx.addedNodes[0];
          while (d && d !== document && !d.host) {
            d = d.parentNode;
          }
          var u = d && (d.URL || d._URL || (d.host && d.host.localName)) || '';
          u = u.split('/?').shift().split('/').pop();
        }
    }
    console.group('mutations (%d) [%s]', mutations.length, u || '');
  }
  //
  mutations.forEach(function(mx) {
    //logFlags.dom && console.group('mutation');
    if (mx.type === 'childList') {
      forEach(mx.addedNodes, function(n) {
        //logFlags.dom && console.log(n.localName);
        if (filter(n)) {
          return;
        }
        // nodes added may need lifecycle management
        addedNode(n);
      });
      // removed nodes may need lifecycle management
      forEach(mx.removedNodes, function(n) {
        //logFlags.dom && console.log(n.localName);
        if (filter(n)) {
          return;
        }
        removedNode(n);
      });
    }
    //logFlags.dom && console.groupEnd();
  });
  logFlags.dom && console.groupEnd();
};

var observer = new MutationObserver(handler);

function takeRecords() {
  // TODO(sjmiles): ask Raf why we have to call handler ourselves
  handler(observer.takeRecords());
}

var forEach = Array.prototype.forEach.call.bind(Array.prototype.forEach);

function observe(inRoot) {
  observer.observe(inRoot, {childList: true, subtree: true});
}

function observeDocument(document) {
  observe(document);
}

function upgradeDocument(document) {
  logFlags.dom && console.group('upgradeDocument: ', (document.URL || document._URL || '').split('/').pop());
  addedNode(document);
  logFlags.dom && console.groupEnd();
}

// exports

scope.watchShadow = watchShadow;
scope.upgradeAll = addedNode;
scope.upgradeSubtree = addedSubtree;

scope.observeDocument = observeDocument;
scope.upgradeDocument = upgradeDocument;

scope.takeRecords = takeRecords;

})(window.CustomElements);

/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */

(function(scope) {

if (!scope) {
  scope = window.HTMLImports = {flags:{}};
}

// imports

var xhr = scope.xhr;

// importer

var IMPORT_LINK_TYPE = 'import';
var STYLE_LINK_TYPE = 'stylesheet';

// highlander object represents a primary document (the argument to 'load')
// at the root of a tree of documents

// for any document, importer:
// - loads any linked documents (with deduping), modifies paths and feeds them back into importer
// - loads text of external script tags
// - loads text of external style tags inside of <element>, modifies paths

// when importer 'modifies paths' in a document, this includes
// - href/src/action in node attributes
// - paths in inline stylesheets
// - all content inside templates

// linked style sheets in an import have their own path fixed up when their containing import modifies paths
// linked style sheets in an <element> are loaded, and the content gets path fixups
// inline style sheets get path fixups when their containing import modifies paths

var loader;

var importer = {
  documents: {},
  cache: {},
  preloadSelectors: [
    'link[rel=' + IMPORT_LINK_TYPE + ']',
    'element link[rel=' + STYLE_LINK_TYPE + ']',
    'template',
    'script[src]:not([type])',
    'script[src][type="text/javascript"]'
  ].join(','),
  loader: function(next) {
    // construct a loader instance
    loader = new Loader(importer.loaded, next);
    // alias the loader cache (for debugging)
    loader.cache = importer.cache;
    return loader;
  },
  load: function(doc, next) {
    // construct a loader instance
    loader = importer.loader(next);
    // add nodes from document into loader queue
    importer.preload(doc);
  },
  preload: function(doc) {
    // all preloadable nodes in inDocument
    var nodes = doc.querySelectorAll(importer.preloadSelectors);
    // from the main document, only load imports
    // TODO(sjmiles): do this by altering the selector list instead
    nodes = this.filterMainDocumentNodes(doc, nodes);
    // extra link nodes from templates, filter templates out of the nodes list
    nodes = this.extractTemplateNodes(nodes);
    // add these nodes to loader's queue
    loader.addNodes(nodes);
  },
  filterMainDocumentNodes: function(doc, nodes) {
    if (doc === document) {
      nodes = Array.prototype.filter.call(nodes, function(n) {
        return !isScript(n);
      });
    }
    return nodes;
  },
  extractTemplateNodes: function(nodes) {
    var extra = [];
    nodes = Array.prototype.filter.call(nodes, function(n) {
      if (n.localName === 'template') {
        if (n.content) {
          var l$ = n.content.querySelectorAll('link[rel=' + STYLE_LINK_TYPE +
            ']');
          if (l$.length) {
            extra = extra.concat(Array.prototype.slice.call(l$, 0));
          }
        }
        return false;
      }
      return true;
    });
    if (extra.length) {
      nodes = nodes.concat(extra);
    }
    return nodes;
  },
  loaded: function(url, elt, resource) {
    if (isDocumentLink(elt)) {
      var document = importer.documents[url];
      // if we've never seen a document at this url
      if (!document) {
        // generate an HTMLDocument from data
        document = makeDocument(resource, url);
        // resolve resource paths relative to host document
        path.resolvePathsInHTML(document);
        // cache document
        importer.documents[url] = document;
        // add nodes from this document to the loader queue
        importer.preload(document);
      }
      // store import record
      elt.import = {
        href: url,
        ownerNode: elt,
        content: document
      };
      // store document resource
      elt.content = resource = document;
    }
    // store generic resource
    // TODO(sorvell): fails for nodes inside <template>.content
    // see https://code.google.com/p/chromium/issues/detail?id=249381.
    elt.__resource = resource;
    // css path fixups
    if (isStylesheetLink(elt)) {
      path.resolvePathsInStylesheet(elt);
    }
  }
};

function isDocumentLink(elt) {
  return isLinkRel(elt, IMPORT_LINK_TYPE);
}

function isStylesheetLink(elt) {
  return isLinkRel(elt, STYLE_LINK_TYPE);
}

function isLinkRel(elt, rel) {
  return elt.localName === 'link' && elt.getAttribute('rel') === rel;
}

function isScript(elt) {
  return elt.localName === 'script';
}

function makeDocument(resource, url) {
  // create a new HTML document
  var doc = resource;
  if (!(doc instanceof Document)) {
    doc = document.implementation.createHTMLDocument(IMPORT_LINK_TYPE);
    // install html
    doc.body.innerHTML = resource;
  }
  // cache the new document's source url
  doc._URL = url;
  // establish a relative path via <base>
  var base = doc.createElement('base');
  base.setAttribute('href', document.baseURI || document.URL);
  doc.head.appendChild(base);
  // TODO(sorvell): ideally this code is not aware of Template polyfill,
  // but for now the polyfill needs help to bootstrap these templates
  if (window.HTMLTemplateElement && HTMLTemplateElement.bootstrap) {
    HTMLTemplateElement.bootstrap(doc);
  }
  return doc;
}

var Loader = function(onLoad, onComplete) {
  this.onload = onLoad;
  this.oncomplete = onComplete;
  this.inflight = 0;
  this.pending = {};
  this.cache = {};
};

Loader.prototype = {
  addNodes: function(nodes) {
    // number of transactions to complete
    this.inflight += nodes.length;
    // commence transactions
    forEach(nodes, this.require, this);
    // anything to do?
    this.checkDone();
  },
  require: function(elt) {
    var url = path.nodeUrl(elt);
    // TODO(sjmiles): ad-hoc
    elt.__nodeUrl = url;
    // deduplication
    if (!this.dedupe(url, elt)) {
      // fetch this resource
      this.fetch(url, elt);
    }
  },
  dedupe: function(url, elt) {
    if (this.pending[url]) {
      // add to list of nodes waiting for inUrl
      this.pending[url].push(elt);
      // don't need fetch
      return true;
    }
    if (this.cache[url]) {
      // complete load using cache data
      this.onload(url, elt, loader.cache[url]);
      // finished this transaction
      this.tail();
      // don't need fetch
      return true;
    }
    // first node waiting for inUrl
    this.pending[url] = [elt];
    // need fetch (not a dupe)
    return false;
  },
  fetch: function(url, elt) {
    var receiveXhr = function(err, resource) {
      this.receive(url, elt, err, resource);
    }.bind(this);
    xhr.load(url, receiveXhr);
    // TODO(sorvell): blocked on
    // https://code.google.com/p/chromium/issues/detail?id=257221
    // xhr'ing for a document makes scripts in imports runnable; otherwise
    // they are not; however, it requires that we have doctype=html in
    // the import which is unacceptable. This is only needed on Chrome
    // to avoid the bug above.
    /*
    if (isDocumentLink(elt)) {
      xhr.loadDocument(url, receiveXhr);
    } else {
      xhr.load(url, receiveXhr);
    }
    */
  },
  receive: function(url, elt, err, resource) {
    if (!err) {
      loader.cache[url] = resource;
    }
    loader.pending[url].forEach(function(e) {
      if (!err) {
        this.onload(url, e, resource);
      }
      this.tail();
    }, this);
    loader.pending[url] = null;
  },
  tail: function() {
    --this.inflight;
    this.checkDone();
  },
  checkDone: function() {
    if (!this.inflight) {
      this.oncomplete();
    }
  }
};

var URL_ATTRS = ['href', 'src', 'action'];
var URL_ATTRS_SELECTOR = '[' + URL_ATTRS.join('],[') + ']';
var URL_TEMPLATE_SEARCH = '{{.*}}';

var path = {
  nodeUrl: function(node) {
    return path.resolveUrl(path.documentURL, path.hrefOrSrc(node));
  },
  hrefOrSrc: function(node) {
    return node.getAttribute("href") || node.getAttribute("src");
  },
  documentUrlFromNode: function(node) {
    return path.getDocumentUrl(node.ownerDocument || node);
  },
  getDocumentUrl: function(doc) {
    var url = doc &&
        // TODO(sjmiles): ShadowDOMPolyfill intrusion
        (doc._URL || (doc.impl && doc.impl._URL)
            || doc.baseURI || doc.URL)
                || '';
    // take only the left side if there is a #
    return url.split('#')[0];
  },
  resolveUrl: function(baseUrl, url) {
    if (this.isAbsUrl(url)) {
      return url;
    }
    return this.compressUrl(this.urlToPath(baseUrl) + url);
  },
  resolveRelativeUrl: function(baseUrl, url) {
    if (this.isAbsUrl(url)) {
      return url;
    }
    return this.makeDocumentRelPath(this.resolveUrl(baseUrl, url));
  },
  isAbsUrl: function(url) {
    return /(^data:)|(^http[s]?:)|(^\/)/.test(url);
  },
  urlToPath: function(baseUrl) {
    var parts = baseUrl.split("/");
    parts.pop();
    parts.push('');
    return parts.join("/");
  },
  compressUrl: function(url) {
    var search = '';
    var searchPos = url.indexOf('?');
    // query string is not part of the path
    if (searchPos > -1) {
      search = url.substring(searchPos);
      url = url.substring(searchPos, 0);
    }
    var parts = url.split('/');
    for (var i=0, p; i<parts.length; i++) {
      p = parts[i];
      if (p === '..') {
        parts.splice(i-1, 2);
        i -= 2;
      }
    }
    return parts.join('/') + search;
  },
  makeDocumentRelPath: function(url) {
    // test url against document to see if we can construct a relative path
    path.urlElt.href = url;
    // IE does not set host if same as document
    if (!path.urlElt.host || 
        (path.urlElt.host === window.location.host &&
        path.urlElt.protocol === window.location.protocol)) {
      return this.makeRelPath(path.documentURL, path.urlElt.href);
    } else {
      return url;
    }
  },
  // make a relative path from source to target
  makeRelPath: function(source, target) {
    var s = source.split('/');
    var t = target.split('/');
    while (s.length && s[0] === t[0]){
      s.shift();
      t.shift();
    }
    for(var i = 0, l = s.length-1; i < l; i++) {
      t.unshift('..');
    }
    var r = t.join('/');
    return r;
  },
  resolvePathsInHTML: function(root, url) {
    url = url || path.documentUrlFromNode(root)
    path.resolveAttributes(root, url);
    path.resolveStyleElts(root, url);
    // handle template.content
    var templates = root.querySelectorAll('template');
    if (templates) {
      forEach(templates, function(t) {
        if (t.content) {
          path.resolvePathsInHTML(t.content, url);
        }
      });
    }
  },
  resolvePathsInStylesheet: function(sheet) {
    var docUrl = path.nodeUrl(sheet);
    sheet.__resource = path.resolveCssText(sheet.__resource, docUrl);
  },
  resolveStyleElts: function(root, url) {
    var styles = root.querySelectorAll('style');
    if (styles) {
      forEach(styles, function(style) {
        style.textContent = path.resolveCssText(style.textContent, url);
      });
    }
  },
  resolveCssText: function(cssText, baseUrl) {
    return cssText.replace(/url\([^)]*\)/g, function(match) {
      // find the url path, ignore quotes in url string
      var urlPath = match.replace(/["']/g, "").slice(4, -1);
      urlPath = path.resolveRelativeUrl(baseUrl, urlPath);
      return "url(" + urlPath + ")";
    });
  },
  resolveAttributes: function(root, url) {
    // search for attributes that host urls
    var nodes = root && root.querySelectorAll(URL_ATTRS_SELECTOR);
    if (nodes) {
      forEach(nodes, function(n) {
        this.resolveNodeAttributes(n, url);
      }, this);
    }
  },
  resolveNodeAttributes: function(node, url) {
    URL_ATTRS.forEach(function(v) {
      var attr = node.attributes[v];
      if (attr && attr.value &&
         (attr.value.search(URL_TEMPLATE_SEARCH) < 0)) {
        var urlPath = path.resolveRelativeUrl(url, attr.value);
        attr.value = urlPath;
      }
    });
  }
};

path.documentURL = path.getDocumentUrl(document);
path.urlElt = document.createElement('a');

xhr = xhr || {
  async: true,
  ok: function(request) {
    return (request.status >= 200 && request.status < 300)
        || (request.status === 304)
        || (request.status === 0);
  },
  load: function(url, next, nextContext) {
    var request = new XMLHttpRequest();
    if (scope.flags.debug || scope.flags.bust) {
      url += '?' + Math.random();
    }
    request.open('GET', url, xhr.async);
    request.addEventListener('readystatechange', function(e) {
      if (request.readyState === 4) {
        next.call(nextContext, !xhr.ok(request) && request,
          request.response, url);
      }
    });
    request.send();
    return request;
  },
  loadDocument: function(url, next, nextContext) {
    this.load(url, next, nextContext).responseType = 'document';
  }
};

var forEach = Array.prototype.forEach.call.bind(Array.prototype.forEach);

// exports

scope.path = path;
scope.xhr = xhr;
scope.importer = importer;
scope.getDocumentUrl = path.getDocumentUrl;
scope.IMPORT_LINK_TYPE = IMPORT_LINK_TYPE;

})(window.HTMLImports);

/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */

(function(scope) {

var IMPORT_LINK_TYPE = 'import';

// highlander object for parsing a document tree

var importParser = {
  selectors: [
    'link[rel=' + IMPORT_LINK_TYPE + ']',
    'link[rel=stylesheet]',
    'style',
    'script:not([type])',
    'script[type="text/javascript"]'
  ],
  map: {
    link: 'parseLink',
    script: 'parseScript',
    style: 'parseGeneric'
  },
  parse: function(inDocument) {
    if (!inDocument.__importParsed) {
      // only parse once
      inDocument.__importParsed = true;
      // all parsable elements in inDocument (depth-first pre-order traversal)
      var elts = inDocument.querySelectorAll(importParser.selectors);
      // for each parsable node type, call the mapped parsing method
      forEach(elts, function(e) {
        importParser[importParser.map[e.localName]](e);
      });
    }
  },
  parseLink: function(linkElt) {
    if (isDocumentLink(linkElt)) {
      if (linkElt.content) {
        importParser.parse(linkElt.content);
      }
    } else {
      this.parseGeneric(linkElt);
    }
  },
  parseGeneric: function(elt) {
    if (needsMainDocumentContext(elt)) {
      document.head.appendChild(elt);
    }
  },
  parseScript: function(scriptElt) {
    if (needsMainDocumentContext(scriptElt)) {
      // acquire code to execute
      var code = (scriptElt.__resource || scriptElt.textContent).trim();
      if (code) {
        // calculate source map hint
        var moniker = scriptElt.__nodeUrl;
        if (!moniker) {
          var moniker = scope.path.documentUrlFromNode(scriptElt);
          // there could be more than one script this url
          var tag = '[' + Math.floor((Math.random()+1)*1000) + ']';
          // TODO(sjmiles): Polymer hack, should be pluggable if we need to allow 
          // this sort of thing
          var matches = code.match(/Polymer\(['"]([^'"]*)/);
          tag = matches && matches[1] || tag;
          // tag the moniker
          moniker += '/' + tag + '.js';
        }
        // source map hint
        code += "\n//# sourceURL=" + moniker + "\n";
        // evaluate the code
        eval.call(window, code);
      }
    }
  }
};

var forEach = Array.prototype.forEach.call.bind(Array.prototype.forEach);

function isDocumentLink(elt) {
  return elt.localName === 'link'
      && elt.getAttribute('rel') === IMPORT_LINK_TYPE;
}

function needsMainDocumentContext(node) {
  // nodes can be moved to the main document:
  // if they are in a tree but not in the main document and not children of <element>
  return node.parentNode && !inMainDocument(node) 
      && !isElementElementChild(node);
}

function inMainDocument(elt) {
  return elt.ownerDocument === document ||
    // TODO(sjmiles): ShadowDOMPolyfill intrusion
    elt.ownerDocument.impl === document;
}

function isElementElementChild(elt) {
  return elt.parentNode && elt.parentNode.localName === 'element';
}

// exports

scope.parser = importParser;

})(HTMLImports);
/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */
(function(){

// bootstrap

// IE shim for CustomEvent
if (typeof window.CustomEvent !== 'function') {
  window.CustomEvent = function(inType) {
     var e = document.createEvent('HTMLEvents');
     e.initEvent(inType, true, true);
     return e;
  };
}

function bootstrap() {
  // preload document resource trees
  HTMLImports.importer.load(document, function() {
    HTMLImports.parser.parse(document);
    HTMLImports.readyTime = new Date().getTime();
    // send HTMLImportsLoaded when finished
    document.dispatchEvent(
      new CustomEvent('HTMLImportsLoaded', {bubbles: true})
    );
  });
};

if (document.readyState === 'complete') {
  bootstrap();
} else {
  window.addEventListener('DOMContentLoaded', bootstrap);
}

})();

/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */

(function() {

// import

var IMPORT_LINK_TYPE = window.HTMLImports ? HTMLImports.IMPORT_LINK_TYPE : 'none';

// highlander object for parsing a document tree

var parser = {
  selectors: [
    'link[rel=' + IMPORT_LINK_TYPE + ']'
  ],
  map: {
    link: 'parseLink'
  },
  parse: function(inDocument) {
    if (!inDocument.__parsed) {
      // only parse once
      inDocument.__parsed = true;
      // all parsable elements in inDocument (depth-first pre-order traversal)
      var elts = inDocument.querySelectorAll(parser.selectors);
      // for each parsable node type, call the mapped parsing method
      forEach(elts, function(e) {
        parser[parser.map[e.localName]](e);
      });
      // upgrade all upgradeable static elements, anything dynamically
      // created should be caught by observer
      CustomElements.upgradeDocument(inDocument);
      // observe document for dom changes
      CustomElements.observeDocument(inDocument);
    }
  },
  parseLink: function(linkElt) {
    // imports
    if (isDocumentLink(linkElt)) {
      this.parseImport(linkElt);
    }
  },
  parseImport: function(linkElt) {
    if (linkElt.content) {
      parser.parse(linkElt.content);
    }
  }
};

function isDocumentLink(inElt) {
  return (inElt.localName === 'link'
      && inElt.getAttribute('rel') === IMPORT_LINK_TYPE);
}

var forEach = Array.prototype.forEach.call.bind(Array.prototype.forEach);

// exports

CustomElements.parser = parser;

})();
/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */
(function(){

// bootstrap parsing
function bootstrap() {
  // parse document
  CustomElements.parser.parse(document);
  // one more pass before register is 'live'
  CustomElements.upgradeDocument(document);  
  // choose async
  var async = window.Platform && Platform.endOfMicrotask ? 
    Platform.endOfMicrotask :
    setTimeout;
  async(function() {
    // set internal 'ready' flag, now document.register will trigger 
    // synchronous upgrades
    CustomElements.ready = true;
    // capture blunt profiling data
    CustomElements.readyTime = Date.now();
    if (window.HTMLImports) {
      CustomElements.elapsed = CustomElements.readyTime - HTMLImports.readyTime;
    }
    // notify the system that we are bootstrapped
    document.body.dispatchEvent(
      new CustomEvent('WebComponentsReady', {bubbles: true})
    );
  });
}

// CustomEvent shim for IE
if (typeof window.CustomEvent !== 'function') {
  window.CustomEvent = function(inType) {
     var e = document.createEvent('HTMLEvents');
     e.initEvent(inType, true, true);
     return e;
  };
}

if (document.readyState === 'complete') {
  bootstrap();
} else {
  var loadEvent = window.HTMLImports ? 'HTMLImportsLoaded' : 'DOMContentLoaded';
  window.addEventListener(loadEvent, bootstrap);
}

})();

(function () {

/*** Variables ***/

  var win = window,
    doc = document,
    noop = function(){},
    trueop = function(){ return true; },
    regexPseudoSplit = /([\w-]+(?:\([^\)]+\))?)/g,
    regexPseudoReplace = /(\w*)(?:\(([^\)]*)\))?/,
    regexDigits = /(\d+)/g,
    keypseudo = {
      action: function (pseudo, event) {
        return pseudo.value.match(regexDigits).indexOf(String(event.keyCode)) > -1 == (pseudo.name == 'keypass') || null;
      }
    },
    prefix = (function () {
      var styles = win.getComputedStyle(doc.documentElement, ''),
          pre = (Array.prototype.slice
            .call(styles)
            .join('')
            .match(/-(moz|webkit|ms)-/) || (styles.OLink === '' && ['', 'o'])
          )[1];
      return {
        dom: pre == 'ms' ? 'MS' : pre,
        lowercase: pre,
        css: '-' + pre + '-',
        js: pre == 'ms' ? pre : pre[0].toUpperCase() + pre.substr(1)
      };
    })(),
    matchSelector = Element.prototype.matchesSelector || Element.prototype[prefix.lowercase + 'MatchesSelector'],
    mutation = win.MutationObserver || win[prefix.js + 'MutationObserver'];

/*** Functions ***/

// Utilities

  var typeCache = {},
      typeString = typeCache.toString,
      typeRegexp = /\s([a-zA-Z]+)/;
  function typeOf(obj) {
    var type = typeString.call(obj);
    return typeCache[type] || (typeCache[type] = type.match(typeRegexp)[1].toLowerCase());
  }

  function clone(item, type){
    var fn = clone[type || typeOf(item)];
    return fn ? fn(item) : item;
  }
    clone.object = function(src){
      var obj = {};
      for (var key in src) obj[key] = clone(src[key]);
      return obj;
    };
    clone.array = function(src){
      var i = src.length, array = new Array(i);
      while (i--) array[i] = clone(src[i]);
      return array;
    };

  var unsliceable = ['undefined', 'null', 'number', 'boolean', 'string', 'function'];
  function toArray(obj){
    return unsliceable.indexOf(typeOf(obj)) == -1 ?
    Array.prototype.slice.call(obj, 0) :
    [obj];
  }

// DOM
  var str = '';
  function query(element, selector){
    return (selector || str).length ? toArray(element.querySelectorAll(selector)) : [];
  }

  function parseMutations(element, mutations) {
    var diff = { added: [], removed: [] };
    mutations.forEach(function(record){
      record._mutation = true;
      for (var z in diff) {
        var type = element._records[(z == 'added') ? 'inserted' : 'removed'],
          nodes = record[z + 'Nodes'], length = nodes.length;
        for (var i = 0; i < length && diff[z].indexOf(nodes[i]) == -1; i++){
          diff[z].push(nodes[i]);
          type.forEach(function(fn){
            fn(nodes[i], record);
          });
        }
      }
    });
  }

// Mixins

  function mergeOne(source, key, current){
    var type = typeOf(current);
    if (type == 'object' && typeOf(source[key]) == 'object') xtag.merge(source[key], current);
    else source[key] = clone(current, type);
    return source;
  }

  function mergeMixin(type, mixin, option) {
    var original = {};
    for (var o in option) original[o.split(':')[0]] = true;
    for (var x in mixin) if (!original[x.split(':')[0]]) option[x] = mixin[x];
  }

  function applyMixins(tag) {
    tag.mixins.forEach(function (name) {
      var mixin = xtag.mixins[name];
      for (var type in mixin) {
        switch (type) {
          case 'lifecycle': case 'methods':
            mergeMixin(type, mixin[type], tag[type]);
            break;
          case 'accessors': case 'prototype':
            for (var z in mixin[type]) mergeMixin(z, mixin[type], tag.accessors);
            break;
          case 'events':
            break;
        }
      }
    });
    return tag;
  }

// Events
  
  function delegateAction(pseudo, event) {
    var target = query(this, pseudo.value).filter(function(node){
      return node == event.target || node.contains ? node.contains(event.target) : null;
    })[0];
    return target ? pseudo.listener = pseudo.listener.bind(target) : null;
  }

  function touchFilter(event) {
    if (event.type.match('touch')){
      event.target.__touched__ = true;
    }
    else if (event.target.__touched__ && event.type.match('mouse')){
      delete event.target.__touched__;
      return;
    }
    return true;
  }

  function createFlowEvent(type) {
    var flow = type == 'over';
    return {
      attach: 'OverflowEvent' in win ? 'overflowchanged' : [],
      condition: function (event, custom) {
        event.flow = type;
        return event.type == (type + 'flow') ||
        ((event.orient === 0 && event.horizontalOverflow == flow) ||
        (event.orient == 1 && event.verticalOverflow == flow) ||
        (event.orient == 2 && event.horizontalOverflow == flow && event.verticalOverflow == flow));
      }
    };
  }

  function writeProperty(key, event, base, desc){
    if (desc) event[key] = base[key];
    else Object.defineProperty(event, key, {
      writable: true,
      enumerable: true,
      value: base[key]
    });
  }
  
  var skipProps = {};
  for (var z in document.createEvent('CustomEvent')) skipProps[z] = 1;
  function inheritEvent(event, base){
    var desc = Object.getOwnPropertyDescriptor(event, 'target');
    for (var z in base) {
      if (!skipProps[z]) writeProperty(z, event, base, desc);
    }
    event.baseEvent = base;
  }

// Accessors

  function getArgs(attr, value){
    return {
      value: attr.boolean ? '' : value,
      method: attr.boolean && !value ? 'removeAttribute' : 'setAttribute'
    };
  }

  function modAttr(element, attr, name, value){
    var args = getArgs(attr, value);
    element[args.method](name, args.value);
  }

  function syncAttr(element, attr, name, value, method){
    var nodes = attr.property ? [element.xtag[attr.property]] : attr.selector ? xtag.query(element, attr.selector) : [],
        index = nodes.length;
    while (index--) nodes[index][method](name, value);
  }

  function updateView(element, name, value){
    if (element.__view__){
      element.__view__.updateBindingValue(element, name, value);
    }
  }

  function attachProperties(tag, prop, z, accessor, attr, name){
    var key = z.split(':'), type = key[0];
    if (type == 'get') {
      key[0] = prop;
      tag.prototype[prop].get = xtag.applyPseudos(key.join(':'), accessor[z], tag.pseudos);
    }
    else if (type == 'set') {
      key[0] = prop;
      var setter = tag.prototype[prop].set = xtag.applyPseudos(key.join(':'), attr ? function(value){
        this.xtag._skipSet = true;
        if (!this.xtag._skipAttr) modAttr(this, attr, name, value);
        if (this.xtag._skipAttr && attr.skip) delete this.xtag._skipAttr;
        accessor[z].call(this, attr.boolean ? !!value : value);
        updateView(this, name, value);
        delete this.xtag._skipSet;
      } : accessor[z] ? function(value){
        accessor[z].call(this, value);
        updateView(this, name, value);
      } : null, tag.pseudos);

      if (attr) attr.setter = setter;
    }
    else tag.prototype[prop][z] = accessor[z];
  }

  function parseAccessor(tag, prop){
    tag.prototype[prop] = {};
    var accessor = tag.accessors[prop],
        attr = accessor.attribute,
        name = attr && attr.name ? attr.name.toLowerCase() : prop;

    if (attr) {
      attr.key = prop;
      tag.attributes[name] = attr;
    }

    for (var z in accessor) attachProperties(tag, prop, z, accessor, attr, name);

    if (attr) {
      if (!tag.prototype[prop].get) {
        var method = (attr.boolean ? 'has' : 'get') + 'Attribute';
        tag.prototype[prop].get = function(){
          return this[method](name);
        };
      }
      if (!tag.prototype[prop].set) tag.prototype[prop].set = function(value){
        modAttr(this, attr, name, value);
        updateView(this, name, value);
      };
    }
  }

/*** X-Tag Object Definition ***/

  var xtag = {
    tags: {},
    defaultOptions: {
      pseudos: [],
      mixins: [],
      events: {},
      methods: {},
      accessors: {},
      lifecycle: {},
      attributes: {},
      'prototype': {
        xtag: {
          get: function(){
            return this.__xtag__ ? this.__xtag__ : (this.__xtag__ = { data: {} });
          }
        }
      }
    },
    register: function (name, options) {
      var _name;
      if (typeof name == 'string') {
        _name = name.toLowerCase();
      } else {
        return;
      }

      // save prototype for actual object creation below
      var basePrototype = options.prototype;
      delete options.prototype;

      var tag = xtag.tags[_name] = applyMixins(xtag.merge({}, xtag.defaultOptions, options));

      for (var z in tag.events) tag.events[z] = xtag.parseEvent(z, tag.events[z]);
      for (z in tag.lifecycle) tag.lifecycle[z.split(':')[0]] = xtag.applyPseudos(z, tag.lifecycle[z], tag.pseudos);
      for (z in tag.methods) tag.prototype[z.split(':')[0]] = { value: xtag.applyPseudos(z, tag.methods[z], tag.pseudos), enumerable: true };
      for (z in tag.accessors) parseAccessor(tag, z);

      var ready = tag.lifecycle.created || tag.lifecycle.ready;
      tag.prototype.createdCallback = {
        enumerable: true,
        value: function(){
          var element = this;
          xtag.addEvents(this, tag.events);
          tag.mixins.forEach(function(mixin){
            if (xtag.mixins[mixin].events) xtag.addEvents(element, xtag.mixins[mixin].events);
          });
          var output = ready ? ready.apply(this, toArray(arguments)) : null;
          for (var name in tag.attributes) {
            var attr = tag.attributes[name],
                hasAttr = this.hasAttribute(name);
            if (hasAttr || attr.boolean) {
              this[attr.key] = attr.boolean ? hasAttr : this.getAttribute(name);
            }
          }
          tag.pseudos.forEach(function(obj){
            obj.onAdd.call(element, obj);
          });
          return output;
        }
      };

      if (tag.lifecycle.inserted) tag.prototype.enteredDocumentCallback = { value: tag.lifecycle.inserted, enumerable: true };
      if (tag.lifecycle.removed) tag.prototype.leftDocumentCallback = { value: tag.lifecycle.removed, enumerable: true };
      if (tag.lifecycle.attributeChanged) tag.prototype.attributeChangedCallback = { value: tag.lifecycle.attributeChanged, enumerable: true };

      var setAttribute = tag.prototype.setAttribute || HTMLElement.prototype.setAttribute;
      tag.prototype.setAttribute = {
        writable: true,
        enumberable: true,
        value: function (name, value){
          var attr = tag.attributes[name.toLowerCase()];
          if (!this.xtag._skipAttr) setAttribute.call(this, name, attr && attr.boolean ? '' : value);
          if (attr) {
            if (attr.setter && !this.xtag._skipSet) {
              this.xtag._skipAttr = true;
              attr.setter.call(this, attr.boolean ? true : value);
            }
            value = attr.skip ? attr.boolean ? this.hasAttribute(name) : this.getAttribute(name) : value;
            syncAttr(this, attr, name, attr.boolean ? '' : value, 'setAttribute');
          }
          delete this.xtag._skipAttr;
        }
      };

      var removeAttribute = tag.prototype.removeAttribute || HTMLElement.prototype.removeAttribute;
      tag.prototype.removeAttribute = {
        writable: true,
        enumberable: true,
        value: function (name){
          var attr = tag.attributes[name.toLowerCase()];
          if (!this.xtag._skipAttr) removeAttribute.call(this, name);
          if (attr) {
            if (attr.setter && !this.xtag._skipSet) {
              this.xtag._skipAttr = true;
              attr.setter.call(this, attr.boolean ? false : undefined);
            }
            syncAttr(this, attr, name, undefined, 'removeAttribute');
          }
          delete this.xtag._skipAttr;
        }
      };

      var elementProto = basePrototype ?
        basePrototype :
          options['extends'] ?
            Object.create(doc.createElement(options['extends'])
              .constructor).prototype :
          win.HTMLElement.prototype;

      return doc.register(_name, {
        'extends': options['extends'],
        'prototype': Object.create(elementProto, tag.prototype)
      });

    },

    /* Exposed Variables */

    mixins: {},
    prefix: prefix,
    touches: {
      active: [],
      changed: []
    },
    captureEvents: ['focus', 'blur', 'scroll', 'underflow', 'overflow', 'overflowchanged'],
    customEvents: {
      overflow: createFlowEvent('over'),
      underflow: createFlowEvent('under'),
      animationstart: {
        attach: [prefix.dom + 'AnimationStart']
      },
      animationend: {
        attach: [prefix.dom + 'AnimationEnd']
      },
      transitionend: {
        attach: [prefix.dom + 'TransitionEnd']
      },
      move: {
        attach: ['mousemove', 'touchmove'],
        condition: touchFilter
      },
      enter: {
        attach: ['mouseover', 'touchenter'],
        condition: touchFilter
      },
      leave: {
        attach: ['mouseout', 'touchleave'],
        condition: touchFilter
      },
      tapstart: {
        observe: {
          mousedown: doc,
          touchstart: doc
        },
        condition: touchFilter
      },
      tapend: {
        observe: {
          mouseup: doc,
          touchend: doc
        },
        condition: touchFilter
      },
      tapmove: {
        attach: ['tapstart', 'dragend', 'touchcancel'],
        condition: function(event, custom){
          switch (event.type) {
            case 'move':  return true;
            case 'dragover':
              var last = custom.lastDrag || {};
              custom.lastDrag = event;
              return (last.pageX != event.pageX && last.pageY != event.pageY) || null;
            case 'tapstart':
              custom.touches = custom.touches || 1;
              if (!custom.move) {
                custom.current = this;
                custom.move = xtag.addEvents(this, {
                  move: custom.listener,
                  dragover: custom.listener
                });
                custom.tapend = xtag.addEvent(doc, 'tapend', custom.listener);
              }
              break;
            case 'tapend': case 'dragend': case 'touchcancel':
              custom.touches--;
              if (!custom.touches) {
                xtag.removeEvents(custom.current , custom.move || {});
                xtag.removeEvent(doc, custom.tapend || {});
                delete custom.lastDrag;
                delete custom.current;
                delete custom.tapend;
                delete custom.move;
              }
          }
        }
      }
    },
    pseudos: {
      keypass: keypseudo,
      keyfail: keypseudo,
      delegate: { action: delegateAction },
      within: {
        action: delegateAction,
        onAdd: function(pseudo){
          var condition = pseudo.source.condition;
          if (condition) pseudo.source.condition = function(event, custom){
            return xtag.query(this, pseudo.value).filter(function(node){
              return node == event.target || node.contains ? node.contains(event.target) : null;
            })[0] ? condition.call(this, event, custom) : null;
          };
        }
      },
      preventable: {
        action: function (pseudo, event) {
          return !event.defaultPrevented;
        }
      }
    },

    /* UTILITIES */

    clone: clone,
    typeOf: typeOf,
    toArray: toArray,

    wrap: function (original, fn) {
      return function(){
        var args = toArray(arguments),
          returned = original.apply(this, args);
        return returned === false ? false : fn.apply(this, typeof returned != 'undefined' ? toArray(returned) : args);
      };
    },

    merge: function(source, k, v){
      if (typeOf(k) == 'string') return mergeOne(source, k, v);
      for (var i = 1, l = arguments.length; i < l; i++){
        var object = arguments[i];
        for (var key in object) mergeOne(source, key, object[key]);
      }
      return source;
    },

    uid: function(){
      return Math.random().toString(36).substr(2,10);
    },

    /* DOM */

    query: query,

    skipTransition: function(element, fn, bind){
      var prop = prefix.js + 'TransitionProperty';
      element.style[prop] = element.style.transitionProperty = 'none';
      xtag.requestFrame(function(){
        var callback;
        if (fn) callback = fn.call(bind);
        xtag.requestFrame(function(){
          element.style[prop] = element.style.transitionProperty = '';
          if (callback) xtag.requestFrame(callback);
        });
      });
    },

    requestFrame: (function(){
      var raf = win.requestAnimationFrame ||
        win[prefix.lowercase + 'RequestAnimationFrame'] ||
        function(fn){ return win.setTimeout(fn, 20); };
      return function(fn){
        return raf.call(win, fn);
      };
    })(),

    matchSelector: function (element, selector) {
      return matchSelector.call(element, selector);
    },

    set: function (element, method, value) {
      element[method] = value;
      if (window.CustomElements) CustomElements.upgradeAll(element);
    },

    innerHTML: function(el, html){
      xtag.set(el, 'innerHTML', html);
    },

    hasClass: function (element, klass) {
      return element.className.split(' ').indexOf(klass.trim())>-1;
    },

    addClass: function (element, klass) {
      var list = element.className.trim().split(' ');
      klass.trim().split(' ').forEach(function (name) {
        if (!~list.indexOf(name)) list.push(name);
      });
      element.className = list.join(' ').trim();
      return element;
    },

    removeClass: function (element, klass) {
      var classes = klass.trim().split(' ');
      element.className = element.className.trim().split(' ').filter(function (name) {
        return name && !~classes.indexOf(name);
      }).join(' ');
      return element;
    },

    toggleClass: function (element, klass) {
      return xtag[xtag.hasClass(element, klass) ? 'removeClass' : 'addClass'].call(null, element, klass);
    },

    queryChildren: function (element, selector) {
      var id = element.id,
        guid = element.id = id || 'x_' + xtag.uid(),
        attr = '#' + guid + ' > ';
      selector = attr + (selector + '').replace(',', ',' + attr, 'g');
      var result = element.parentNode.querySelectorAll(selector);
      if (!id) element.removeAttribute('id');
      return toArray(result);
    },

    createFragment: function(content) {
      var frag = doc.createDocumentFragment();
      if (content) {
        var div = frag.appendChild(doc.createElement('div')),
          nodes = toArray(content.nodeName ? arguments : !(div.innerHTML = content) || div.children),
          length = nodes.length,
          index = 0;
        while (index < length) frag.insertBefore(nodes[index++], div);
        frag.removeChild(div);
      }
      return frag;
    },

    manipulate: function(element, fn){
      var next = element.nextSibling,
        parent = element.parentNode,
        frag = doc.createDocumentFragment(),
        returned = fn.call(frag.appendChild(element), frag) || element;
      if (next) parent.insertBefore(returned, next);
      else parent.appendChild(returned);
    },

    /* PSEUDOS */

    applyPseudos: function(key, fn, element, source) {
      var listener = fn,
          pseudos = {};
      if (key.match(':')) {
        var split = key.match(regexPseudoSplit),
            i = split.length;
        while (--i) {
          split[i].replace(regexPseudoReplace, function (match, name, value) {
            if (!xtag.pseudos[name]) throw "pseudo not found: " + name + " " + split;
            var pseudo = pseudos[i] = Object.create(xtag.pseudos[name]);
                pseudo.key = key;
                pseudo.name = name;
                pseudo.value = value;
                pseudo['arguments'] = (value || '').split(',');
                pseudo.action = pseudo.action || trueop;
                pseudo.source = source;
            var last = listener;
            listener = function(){
              var args = toArray(arguments),
                  obj = {
                    key: key,
                    name: name,
                    value: value,
                    source: source,
                    listener: last
                  };
              var output = pseudo.action.apply(this, [obj].concat(args));
              if (output === null || output === false) return output;
              return obj.listener.apply(this, args);
            };
            if (element && pseudo.onAdd) {
              if (element.getAttribute) pseudo.onAdd.call(element, pseudo);
              else element.push(pseudo);
            }
          });
        }
      }
      for (var z in pseudos) {
        if (pseudos[z].onCompiled) listener = pseudos[z].onCompiled(listener, pseudos[z]) || listener;
      }
      return listener;
    },

    removePseudos: function(element, event){
      event._pseudos.forEach(function(obj){
        if (obj.onRemove) obj.onRemove.call(element, obj);
      });
    },

  /*** Events ***/
    
    parseEvent: function(type, fn) {
      var pseudos = type.split(':'),
          key = pseudos.shift(),
          custom = xtag.customEvents[key],
          event = xtag.merge({
            type: key,
            stack: noop,
            condition: trueop,
            attach: [],
            _attach: [],
            pseudos: '',
            _pseudos: [],
            onAdd: noop,
            onRemove: noop
          }, custom || {});
      event.attach = toArray(event.base || event.attach);
      event.chain = key + (event.pseudos.length ? ':' + event.pseudos : '') + (pseudos.length ? ':' + pseudos.join(':') : '');
      var condition = event.condition;
      event.condition = function(e){
        var t = e.touches, tt = e.targetTouches;
        return condition.apply(this, toArray(arguments));
      }; 
      var stack = xtag.applyPseudos(event.chain, fn, event._pseudos, event);
      event.stack = function(e){
        var t = e.touches, tt = e.targetTouches;
        var detail = e.detail || {};
        if (!detail.__stack__) return stack.apply(this, toArray(arguments));
        else if (detail.__stack__ == stack) {
          e.stopPropagation();
          e.cancelBubble = true;
          return stack.apply(this, toArray(arguments));
        }
      };
      event.listener = function(e){
        var args = toArray(arguments),
            output = event.condition.apply(this, args.concat([event]));
        if (!output) return output;
        if (e.type != key) xtag.fireEvent(e.target, key, { baseEvent: e, detail: { __stack__: stack } });
        else return event.stack.apply(this, args);
      };
      event.attach.forEach(function(name) {
        event._attach.push(xtag.parseEvent(name, event.listener));
      });
      if (custom && custom.observe && !custom.__observing__) {
        custom.observer = function(e){
          var output = event.condition.apply(this, toArray(arguments).concat([custom]));
          if (!output) return output;
          xtag.fireEvent(e.target, key, { baseEvent: e });
        };
        for (var z in custom.observe) xtag.addEvent(custom.observe[z] || document, z, custom.observer, true);
        custom.__observing__ = true;
      }
      return event;
    },

    addEvent: function (element, type, fn, capture) {
      var event = (typeof fn == 'function') ? xtag.parseEvent(type, fn) : fn;
      event._pseudos.forEach(function(obj){
        obj.onAdd.call(element, obj);
      });
      event._attach.forEach(function(obj) {
        xtag.addEvent(element, obj.type, obj);
      });
      event.onAdd.call(element, event, event.listener);
      element.addEventListener(event.type, event.stack, capture || xtag.captureEvents.indexOf(event.type) > -1);
      return event;
    },

    addEvents: function (element, obj) {
      var events = {};
      for (var z in obj) {
        events[z] = xtag.addEvent(element, z, obj[z]);
      }
      return events;
    },

    removeEvent: function (element, type, event) {
      event = event || type;
      event.onRemove.call(element, event, event.listener);
      xtag.removePseudos(element, event);
      event._attach.forEach(function(obj) {
        xtag.removeEvent(element, obj);
      });
      element.removeEventListener(event.type, event.stack);
    },

    removeEvents: function(element, obj){
      for (var z in obj) xtag.removeEvent(element, obj[z]);
    },

    fireEvent: function(element, type, options, warn){
      var event = doc.createEvent('CustomEvent');
      options = options || {};
      if (warn) console.warn('fireEvent has been modified, more info here: ');
      event.initCustomEvent(type,
        options.bubbles !== false,
        options.cancelable !== false,
        options.detail
      );
      if (options.baseEvent) inheritEvent(event, options.baseEvent);
      try { element.dispatchEvent(event); }
      catch (e) {
        console.warn('This error may have been caused by a change in the fireEvent method, more info here: ', e);
      }
    },

    addObserver: function(element, type, fn){
      if (!element._records) {
        element._records = { inserted: [], removed: [] };
        if (mutation){
          element._observer = new mutation(function(mutations) {
            parseMutations(element, mutations);
          });
          element._observer.observe(element, {
            subtree: true,
            childList: true,
            attributes: !true,
            characterData: false
          });
        }
        else ['Inserted', 'Removed'].forEach(function(type){
          element.addEventListener('DOMNode' + type, function(event){
            event._mutation = true;
            element._records[type.toLowerCase()].forEach(function(fn){
              fn(event.target, event);
            });
          }, false);
        });
      }
      if (element._records[type].indexOf(fn) == -1) element._records[type].push(fn);
    },

    removeObserver: function(element, type, fn){
      var obj = element._records;
      if (obj && fn){
        obj[type].splice(obj[type].indexOf(fn), 1);
      }
      else{
        obj[type] = [];
      }
    }

  };

/*** Universal Touch ***/

var touchCount = 0, touchTarget = null;

doc.addEventListener('mousedown', function(e){
  touchCount++;
  touchTarget = e.target;
}, true);

doc.addEventListener('mouseup', function(){
  touchCount--;
  touchTarget = null;
}, false);

var UIEventProto = {
  touches: {
    configurable: true,
    get: function(){
      return this.__touches__ ||
        (this.identifier = 0) ||
        (this.__touches__ = touchCount ? [this] : []);
    }
  },
  targetTouches: {
    configurable: true,
    get: function(){
      return this.__targetTouches__ || (this.__targetTouches__ =
        (touchCount && this.currentTarget &&
        (this.currentTarget == touchTarget ||
        (this.currentTarget.contains && this.currentTarget.contains(touchTarget)))) ? [this] : []);
    }
  },
  changedTouches: {
    configurable: true,
    get: function(){
      return this.touches;
    }
  }
};

for (z in UIEventProto){
  UIEvent.prototype[z] = UIEventProto[z];
  Object.defineProperty(UIEvent.prototype, z, UIEventProto[z]);
}

var touchReset = {
    value: null,
    writable: true,
    configurable: true
  },
  TouchEventProto = {
    touches: touchReset,
    targetTouches: touchReset,
    changedTouches: touchReset
  };

if (win.TouchEvent) {
  for (z in TouchEventProto) {
    win.TouchEvent.prototype[z] = TouchEventProto[z];
    Object.defineProperty(win.TouchEvent.prototype, z, TouchEventProto[z]);
  }
}

/*** Custom Event Definitions ***/

  function addTap(el, tap, e){
    if (!el.__tap__) {
      el.__tap__ = { click: e.type == 'mousedown' };
      if (el.__tap__.click) el.addEventListener('click', tap.observer);
      else {
        el.__tap__.scroll = tap.observer.bind(el);
        window.addEventListener('scroll', el.__tap__.scroll, true);
        el.addEventListener('touchmove', tap.observer);
        el.addEventListener('touchcancel', tap.observer);
        el.addEventListener('touchend', tap.observer);
      }
    }
    if (!el.__tap__.click) {
      el.__tap__.x = e.touches[0].pageX;
      el.__tap__.y = e.touches[0].pageY;
    }
  }

  function removeTap(el, tap){
    if (el.__tap__) {
      if (el.__tap__.click) el.removeEventListener('click', tap.observer);
      else {
        window.removeEventListener('scroll', el.__tap__.scroll, true);
        el.removeEventListener('touchmove', tap.observer);
        el.removeEventListener('touchcancel', tap.observer);
        el.removeEventListener('touchend', tap.observer);
      }
      delete el.__tap__;
    }
  }

  function checkTapPosition(el, tap, e){
    var touch = e.changedTouches[0];
    if (
      touch.pageX < el.__tap__.x + tap.gesture.tolerance &&
      touch.pageX > el.__tap__.x - tap.gesture.tolerance &&
      touch.pageY < el.__tap__.y + tap.gesture.tolerance &&
      touch.pageY > el.__tap__.y - tap.gesture.tolerance
    ) return true;
  }

  xtag.customEvents.tap = {
    observe: {
      mousedown: document,
      touchstart: document
    },
    gesture: {
      tolerance: 8
    },
    condition: function(e, tap){
      var el = e.target;
      switch (e.type) {
        case 'touchstart':
          if (el.__tap__ && el.__tap__.click) removeTap(el, tap);
          addTap(el, tap, e);
          return;
        case 'mousedown':
          if (!el.__tap__) addTap(el, tap, e);
          return;
        case 'scroll':
        case 'touchcancel':
          removeTap(this, tap);
          return;
        case 'touchmove':
        case 'touchend':
          if (this.__tap__ && !checkTapPosition(this, tap, e)) {
            removeTap(this, tap);
            return;
          }
          return e.type == 'touchend' || null;
        case 'click':
          removeTap(this, tap);
          return true;
      }
    }
  };

  if (typeof define == 'function' && define.amd) define(xtag);
  else win.xtag = xtag;

  doc.addEventListener('WebComponentsReady', function(){
    xtag.fireEvent(doc.body, 'DOMComponentsLoaded');
  });

})();

(function(){
    // used in mouse events
    var LEFT_MOUSE_BTN = 0;

    // used during creating calendar elements
    var GET_DEFAULT_LABELS = function(){
        return {
            prev: '<',
            next: '>',
            months: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'],
            weekdays: ['Sun', "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        };
    };

    /** returns the given date, but as a Date object representing that date
        without local/timezone information

        ***IMPORTANT*** call this anytime we create a new Date(), in order to
        ensure avoid oddities caused by mixing and matching timezone offsets
    **/
    function toUTCDate(localDate){
        // don't try to reconvert a date already set to UTC time, or
        // the inherent timezone information of JS Dates may change an already
        // converted date
        var utcDate;
        if(localDate.getUTCHours() === 0)
        {
            utcDate = new Date(localDate.valueOf());
        }
        else{
            utcDate = new Date();
            utcDate.setUTCHours(0);
            utcDate.setUTCFullYear(localDate.getFullYear());
            utcDate.setUTCMonth(localDate.getMonth());
            utcDate.setUTCDate(localDate.getDate());
        }

        utcDate.setUTCMinutes(0);
        utcDate.setUTCSeconds(0);
        utcDate.setUTCMilliseconds(0);
        return utcDate;
    }

    // the current date, set to midnight UTC time
    var TODAY = toUTCDate(new Date());

    // constants used in tracking the type of the current drag/paint operation
    var DRAG_ADD = "add";
    var DRAG_REMOVE = "remove";

    // constant representing the class of a day that has been
    // chosen/toggled/selected/whatever
    var CHOSEN_CLASS = "chosen";

    // minifier-friendly strings
    var className = 'className';

    // dom helpers

    // minification wrapper for appendChild
    function appendChild(parent, child) {
        parent.appendChild(child);
    }

    // wrapper for parseInt(*, 10) to make jshint happy about radix params
    // also minification-friendly
    function parseIntDec(num){
        return parseInt(num, 10);
    }

    /** isWeekdayNum: (*) => Boolean

    Checks if the given parameter is a valid weekday number 0-6
    (0=Sunday, 1=Monday, etc)
    **/
    function isWeekdayNum(dayNum){
        var dayInt = parseIntDec(dayNum);
        return (dayInt === dayNum && (!isNaN(dayInt)) &&
                dayInt >= 0 && dayInt <= 6);
    }

    /** isValidDateObj: (*) => Boolean

    simply checks if the given parameter is a valid date object
    **/
    function isValidDateObj(d) {
        return (d instanceof Date)  && !!(d.getTime) && !isNaN(d.getTime());
    }

    /** isArray: (*) => Boolean

    simply checks if the given parameter is an array
    **/
    function isArray(a){
        if(a && a.isArray){
            return a.isArray();
        }
        else{
            return Object.prototype.toString.call(a) === "[object Array]";
        }
    }

    /** makeEl: String => DOM Element

    Takes a string in the format of "tag.classname.classname2" (etc) and
    returns a DOM element of that type with the given classes

    For example, makeEl('div.foo') returns the Node <div class="foo">
    **/
    function makeEl(s) {
        var a = s.split('.');
        var tag = a.shift();
        var el = document.createElement(tag);
        el[className] = a.join(' ');
        return el;
    }

    /** getWindowViewport() => { top: number, left: number,
                                  right: number, bottom: number,
                                  width: number, height: number}

    returns the rectangle of the current window viewport, relative to the
    document
    **/
    function getWindowViewport(){
        var docElem = document.documentElement;
        var rect = {
            left: (docElem.scrollLeft || document.body.scrollLeft || 0),
            top: (docElem.scrollTop || document.body.scrollTop || 0),
            width: docElem.clientWidth,
            height: docElem.clientHeight
        };
        rect.right = rect.left + rect.width;
        rect.bottom = rect.top + rect.height;
        return rect;
    }

    /** getRect: DOM element => { top: number, left: number,
                                  right: number, bottom: number,
                                  width: number, height: number}

    returns the absolute metrics of the given DOM element in relation to the
    document

    returned coordinates already account for any CSS transform scaling on the
    given element
    **/
    function getRect(el){
        var rect = el.getBoundingClientRect();
        var viewport = getWindowViewport();
        var docScrollLeft = viewport.left;
        var docScrollTop = viewport.top;
        return {
            "left": rect.left + docScrollLeft,
            "right": rect.right + docScrollLeft,
            "top": rect.top + docScrollTop,
            "bottom": rect.bottom + docScrollTop,
            "width": rect.width,
            "height": rect.height
        };
    }

    /** addClass: (DOM element, string)

    minification-friendly wrapper of xtag.addClass
    **/
    function addClass(el, c) {
        xtag.addClass(el, c);
    }

    /** removeClass: (DOM element, string)

    minification-friendly wrapper of xtag.removeClass
    **/
    function removeClass(el, c) {
        xtag.removeClass(el, c);
    }

    /** hasClass: (DOM element, string)

    minification-friendly wrapper of xtag.hasClass
    **/
    function hasClass(el, c) {
        return xtag.hasClass(el, c);
    }

    // Date utils

    function getYear(d) {
        return d.getUTCFullYear();
    }
    function getMonth(d) {
        return d.getUTCMonth();
    }
    function getDate(d) {
        return d.getUTCDate();
    }
    function getDay(d){
        return d.getUTCDay();
    }

    /** pad: (Number, Number) => String

    Pads a number with preceding zeros to be padSize digits long

    If given a number with more than padSize digits, truncates the leftmost
    digits to get to a padSize length
    **/
    function pad(n, padSize) {
        var str = n.toString();
        var padZeros = (new Array(padSize)).join('0');
        return (padZeros + str).substr(-padSize);
    }

    /** iso: Date => String

    returns the ISO format representation of a date ("YYYY-MM-DD")
    **/
    function iso(d) {
        return [pad(getYear(d), 4),
                pad(getMonth(d)+1, 2),
                pad(getDate(d), 2)].join('-');
    }

    /** fromIso: String => Date/null

    Given a string, attempts to parse out a date in YYYY-MM-DD format

    If successful, returns the corresponding Date object, otherwise return null
    **/
    var ISO_DATE_REGEX = /(\d{4})[^\d]?(\d{2})[^\d]?(\d{2})/;
    function fromIso(s){
        if (isValidDateObj(s)) return s;
        var d = ISO_DATE_REGEX.exec(s);
        if (d) {
          return toUTCDate(new Date(d[1],d[2]-1,d[3]));
        }
        else{
            return null;
        }
    }

    /** parseSingleDate: String => Date/null

    attempts to parse out the given string as a Date

    If successful, returns the corresponding Date object, otherwise return null

    Valid input formats include any format with a YYYY-MM-DD format or
    is parseable by Date.parse
    **/
    function parseSingleDate(dateStr){
        if(isValidDateObj(dateStr)) return dateStr;

        // cross-browser check for ISO format that is not
        // supported by Date.parse without implicit time zone
        var isoParsed = fromIso(dateStr);
        if(isoParsed){
            return isoParsed;
        }
        else{
            var parsedMs = Date.parse(dateStr);
            if(!isNaN(parsedMs)){
                return toUTCDate(new Date(parsedMs));
            }
            return null;
        }
    }


    /** parseMultiDates: Array/String => (Date/[Date, Date]) array/null

    Given either an array or a JSON string, attempts to parse out the input into
    the given array format:
     - An array whose elements fall into one of the following two formats
        - A Date object representing a single day
          (if the input uses a string instead, this parser will attempt to
           parseSingleDate it)
        - A two element list of Date objects representing the start and
          end dates of a range (if the inputs use strings instead, the parser
          will attempt to parseSingleDate them)

    If the input is parseable into this format, return the resulting 2d array
    Otherwise, return null and console.warn the parsing error

    If given an array that already follows this format, will simply return it
    **/
    function parseMultiDates(multiDateStr){
        var ranges;
        if(isArray(multiDateStr)){
            ranges = multiDateStr.slice(0); // so that this is nondestructive
        }
        else if(isValidDateObj(multiDateStr)){
            return [multiDateStr];
        }
        else if(typeof(multiDateStr) === "string" && multiDateStr.length > 0){
            // check if this is a JSON representing a range of dates
            try{
                ranges = JSON.parse(multiDateStr);
                if(!isArray(ranges)){
                    console.warn("invalid list of ranges", multiDateStr);
                    return null;
                }
            }
            catch(err){
                // check for if this represents a single date
                var parsedSingle = parseSingleDate(multiDateStr);
                if(parsedSingle){
                    return [parsedSingle];
                }
                else{
                    console.warn("unable to parse", multiDateStr,
                                "as JSON or single date");
                    return null;
                }
            }
        }
        else{
            return null;
        }

        // go through and replace each unparsed range with its parsed
        // version (either a singular Date object or a two-item list of
        // a start Date and an end Date)
        for(var i = 0; i < ranges.length; i++){
            var range = ranges[i];

            if(isValidDateObj(range)){
                continue;
            }
            // parse out as single date
            else if(typeof(range) === "string"){
                var parsedDate = parseSingleDate(range);
                if(!parsedDate){
                    console.warn("unable to parse date", range);
                    return null;
                }
                ranges[i] = parsedDate;
            }
            // parse out as 2-item list/range of start/end date
            else if(isArray(range) && range.length === 2){
                var parsedStartDate = parseSingleDate(range[0]);

                if(!parsedStartDate){
                    console.warn("unable to parse start date", range[0],
                                "from range", range);
                    return null;
                }

                var parsedEndDate = parseSingleDate(range[1]);
                if(!parsedEndDate){
                    console.warn("unable to parse end date", range[1],
                                "from range", range);
                    return null;
                }

                if(parsedStartDate.valueOf() > parsedEndDate.valueOf()){
                    console.warn("invalid range", range,
                                ": start date is after end date");
                    return null;
                }
                ranges[i] = [parsedStartDate, parsedEndDate];
            }
            else{
                console.warn("invalid range value: ", range);
                return null;
            }
        }
        return ranges;
    }

    /* from: (Date, number, number, number) => Date

    Create a new date based on the provided date, but with any given
    year/month/date parameters in place of the base date's
    */
    function from(base, y, m, d) {
        if (y === undefined) y = getYear(base);
        if (m === undefined) m = getMonth(base);
        if (d === undefined) d = getDate(base);
        return toUTCDate(new Date(y,m,d));
    }

    /* relOffset: (Date, number, number. number) => Date

    get the date with the given offsets from the base date

    ex: relOffset(foo, 0, -1, 0) returns the date that is exactly one month
        behind foo
    */
    function relOffset(base, y, m, d) {
        return from(base,
                    getYear(base) + y,
                    getMonth(base) + m,
                    getDate(base) + d);
    }

    /** findWeekStart: Date => Date

    Find the date that is the beginning of the given date's week.

    This defaults to finding the nearest Sunday before or on the given date,
    but if firstWeekday is given as a number 0-6 (0=Sunday, 1=Monday, etc),
    that day will be used instead
    **/
    function findWeekStart(d, firstWeekday) {
        firstWeekday = parseIntDec(firstWeekday);
        if(!isWeekdayNum(firstWeekday)){
            firstWeekday = 0;
        }

        for(var step=0; step < 7; step++){
            if(getDay(d) === firstWeekday){
                return d;
            }
            else{
                d = prevDay(d);
            }
        }
        throw "unable to find week start";
    }

    /** findWeekEnd: Date => Date

    Find the date that is the beginning of the given date's week.

    This defaults to finding the nearest Saturday after or on the given date,
    but if lastWeekday is given as a number 0-6 (0=Sunday, 1=Monday, etc),
    that day will be used instead
    **/
    function findWeekEnd(d, lastWeekDay){
        lastWeekDay = parseIntDec(lastWeekDay);
        if(!isWeekdayNum(lastWeekDay)){
            lastWeekDay = 6;
        }

        for(var step=0; step < 7; step++){
            if(getDay(d) === lastWeekDay){
                return d;
            }
            else{
                d = nextDay(d);
            }
        }
        throw "unable to find week end";
    }

    /** findFirst: Date => Date

    Find the first day of the date's month.
    **/
    function findFirst(d) {
        d = new Date(d.valueOf());
        d.setUTCDate(1);
        return toUTCDate(d);
    }

    /** findLast: Date => Date

    Find the last day of the date's month.
    **/
    function findLast(d){
        return prevDay(relOffset(d, 0, 1, 0));
    }

    /** nextDay: Date => Date

    Return the day that comes after the given date's
    **/
    function nextDay(d) {
        return relOffset(d, 0, 0, 1);
    }

    /** prevDay: Date => Date

    Return the day that comes before the given date's
    **/
    function prevDay(d) {
        return relOffset(d, 0, 0, -1);
    }

    /** dateMatches: (Date, (Date/[Date, Date]) array) => Boolean

    Check whether Date `d` is in the list of Date/Date ranges in `matches`.

    If given a single date to check, will check if the two dates fall on the
    same date

    If given an array of Dates/2-item Dateranges (ie: the same format returned
    by parseMultipleDates and used for Calendar._chosenRanges)

    params:
        d                   the date to compare
        matches             if given as a singular date, will check if d is
                            in the same date
                            Otherwise,
    **/
    function dateMatches(d, matches) {
        if (!matches) return;
        matches = (matches.length === undefined) ? [matches] : matches;
        var foundMatch = false;
        matches.forEach(function(match) {
          if (match.length === 2) {
            if (dateInRange(match[0], match[1], d)) {
              foundMatch = true;
            }
          } else {
            if (iso(match) === iso(d)) {
              foundMatch = true;
            }
          }
        });
        return foundMatch;
    }

    /** dateInRange: (Date, Date, Date) => Boolean

    returns true if the date of the given d date (without time information)
    is in between the start and end days
    **/
    function dateInRange(start, end, d) {
        // convert to strings for easier comparison
        return iso(start) <= iso(d) && iso(d) <= iso(end);
    }


    /** sortRanges: (Date/[Date, Date]) array

    given a list of singular dates / 2-item date range lists (ie: the
    same format as returned by parseMultipleDates and used by
    Calendar._chosenRanges), destructively sorts the list to have
    earlier dates come first
    **/
    function sortRanges(ranges){
        ranges.sort(function(rangeA, rangeB){
            var dateA = (isValidDateObj(rangeA)) ? rangeA : rangeA[0];
            var dateB = (isValidDateObj(rangeB)) ? rangeB : rangeB[0];
            return dateA.valueOf() - dateB.valueOf();
        });
    }

    /** makeControls: (data map) => DOM element

    creates and returns the HTML element used to hold the
    navigation controls of the calendar
    **/
    function makeControls(labelData) {
        var controls = makeEl('div.controls');
        var prev = makeEl('span.prev');
        var next = makeEl('span.next');
        prev.innerHTML = labelData.prev;
        next.innerHTML = labelData.next;
        appendChild(controls, prev);
        appendChild(controls, next);
        return controls;
    }


    /** Calendar: datamap

    A representation of the currently displayed calendar's attributes

    Initialized with an optional data map containing any of the following:

     -  "span"  :       The number of months to display at once
                        (default = 1)
    -  "multiple"  :    Whether or not multiple dates are allowed to be chosen
                        at once
                        (default = false)
    -   "view"  :       The cursor date to center the calendar display on
                        For example, a view of Dec 2013 and span 3 will show
                        a calendar encompassing Nov 2013, Dec 2013, and Jan 2014
                        (default = the first date given in data.chosen, or
                                   the current date if data.chosen is
                                   unavailable)
    -   "chosen"  :     A Date/[Date, Date] array, similar to the format of
                        parseMultipleDates' return value
                        Elements consist of both singular Dates and 2-element
                        arrays of Dates representing the start and end dates
                        of a date range
                        (default: [data.view], or [],
                                  if data.view is unavailable)
    - "firstWeekdayNum" :  A number 0-6 (where 0=Sunday, 1=Monday, etc)
                           indicating which day should be used as the start of
                           any given week
                           (this is useful for regions whose weeks start with
                            Monday instead of Sunday)
    **/
    function Calendar(data) {
        // reassign this to minification friendly variable
        var self = this;
        data = data || {};
        self._span = data.span || 1;
        self._multiple = data.multiple || false;
        // initialize private vars
        self._viewDate = self._sanitizeViewDate(data.view, data.chosen);
        self._chosenRanges = self._sanitizeChosenRanges(data.chosen,
                                                                data.view);
        self._firstWeekdayNum = data.firstWeekdayNum || 0;

        // Note that self._el is the .calendar child div,
        // NOT the x-calendar itself
        self._el = makeEl('div.calendar');
        self._labels = GET_DEFAULT_LABELS();

        self._customRenderFn = null;
        self._renderRecursionFlag = false;

        self.render(true);
    }
    // minification friendly variable for Calendar.prototype
    var CALENDAR_PROTOTYPE = Calendar.prototype;

    /** makeMonth: (Date) => DOM element

    For the given view/cursor date's month, creates the HTML DOM elements
    needed to represent this month in the calendar

    Days are created with a data-date attribute containing the ISO string
    representing their date

    For any date that is contained by the given chosen ranges, sets 'chosen'
    classes so that they are marked as chosen for styling

    Also marks the current date with the 'today' class

    params:
        d               the date whose month we will be rendering
    **/
    CALENDAR_PROTOTYPE.makeMonth = function(d) {
        if (!isValidDateObj(d)) throw 'Invalid view date!';
        var firstWeekday = this.firstWeekdayNum;
        var chosen = this.chosen;
        var labels = this.labels;

        var month = getMonth(d);
        var sDate = findWeekStart(findFirst(d), firstWeekday);

        var monthEl = makeEl('div.month');
        // create month label
        var monthLabel = makeEl('div.month-label');
        monthLabel.textContent = labels.months[month] + ' ' + getYear(d);

        appendChild(monthEl, monthLabel);

        // create the weekday labels
        var weekdayLabels = makeEl('div.weekday-labels');
        for(var step = 0; step < 7; step++){
            var weekdayNum = (firstWeekday + step)  % 7;
            var weekdayLabel = makeEl('span.weekday-label');
            weekdayLabel.textContent = labels.weekdays[weekdayNum];
            appendChild(weekdayLabels, weekdayLabel);
        }
        appendChild(monthEl, weekdayLabels);


        // create each week of days in the month
        var week = makeEl('div.week');
        var cDate = sDate;
        var maxDays = 7 * 6; // maximum is 6 weeks displayed at once

        for(step=0; step < maxDays; step++){
          var day = makeEl('span.day');
          day.setAttribute('data-date', iso(cDate));
          day.textContent = getDate(cDate);

          if (getMonth(cDate) !== month) {
            addClass(day, 'badmonth');
          }

          if (dateMatches(cDate, chosen)) {
            addClass(day, CHOSEN_CLASS);
          }

          if(dateMatches(cDate, TODAY)){
            addClass(day, "today");
          }

          appendChild(week, day);
          var oldDate = cDate;
          cDate = nextDay(cDate);
          // if the next day starts a new week, append finished week and see if
          // we are done drawing the month
          if ((step+1) % 7 === 0) {
            appendChild(monthEl, week);
            week = makeEl('div.week');
            // Are we finished drawing the month?
            // Checks month rollover and year rollover
            // (ie: if month or year are after the current ones)
            var done = (getMonth(cDate) > month ||
                        (getMonth(cDate) < month &&
                         getYear(cDate) > getYear(sDate))
                       );
            if(done) break;
          }
        }
        return monthEl;
    };


    /** Calendar._sanitizeViewDate:
                (Date, (Date/[Date,Date]) array / Date) => Date

    given a view Date and an optional chosen range list or chosen date,
    return the Date to use as the view, depending on what information is given

    returns the given view if valid

    otherwise, return the given chosenDate, if it is a single date, or
    the first date in the range, if it is a date/daterange array

    otherwise default to the current date

    params:
        viewDate                    the proposed view date to sanitize
        chosenRanges                (optional) either a single date or a
                                    list of Date/[Date,Date]  ranges
                                    (defaults to this.chosen)
    **/
    CALENDAR_PROTOTYPE._sanitizeViewDate = function(viewDate,
                                                        chosenRanges)
    {
        chosenRanges = (chosenRanges === undefined) ?
                            this.chosen : chosenRanges;
        var saneDate;
        // if given a valid viewDate, return it
        if(isValidDateObj(viewDate)){
           saneDate = viewDate;
        }
        // otherwise if given a single date for chosenRanges, use it
        else if(isValidDateObj(chosenRanges)){
            saneDate = chosenRanges;
        }
        // otherwise, if given a valid chosenRanges, return the first date in
        // the range as the view date
        else if(isArray(chosenRanges) && chosenRanges.length > 0){
            var firstRange = chosenRanges[0];
            if(isValidDateObj(firstRange)){
                saneDate = firstRange;
            }
            else{
                saneDate = firstRange[0];
            }
        }
        // if not given a valid viewDate or chosenRanges, return the current
        // day as the view date
        else{
            saneDate = TODAY;
        }
        return saneDate;
    };

    /** _collapseRanges: (Date/[Date,Date]) array => (Date/[Date,Date]) array

    given a list of dates/dateranges, nondestructively sort by ascending date,
    then collapse/merge any consecutive dates into date ranges and return the
    resulting list
    **/
    function _collapseRanges(ranges){
        ranges = ranges.slice(0); // nondestructive sort
        sortRanges(ranges);

        var collapsed = [];
        for(var i = 0; i < ranges.length; i++){
            var currRange = ranges[i];
            var prevRange = (collapsed.length > 0) ?
                              collapsed[collapsed.length-1] : null;

            var currStart, currEnd;
            var prevStart, prevEnd;

            if(isValidDateObj(currRange)){
                currStart = currEnd = currRange;
            }
            else{
                currStart = currRange[0];
                currEnd = currRange[1];
            }
            // collapse extraneous range into a singular date
            currRange = (dateMatches(currStart, currEnd)) ?
                             currStart : [currStart, currEnd];

            if(isValidDateObj(prevRange)){
                prevStart = prevEnd = prevRange;
            }
            else if(prevRange){
                prevStart = prevRange[0];
                prevEnd = prevRange[1];
            }
            else{
                // if no previous range, just add the current range to the list
                collapsed.push(currRange);
                continue;
            }

            // if we should collapse range, merge with previous range
            if(dateMatches(currStart, [prevRange]) ||
               dateMatches(prevDay(currStart), [prevRange]))
            {
                var minStart = (prevStart.valueOf() < currStart.valueOf()) ?
                                                          prevStart : currStart;
                var maxEnd = (prevEnd.valueOf() > currEnd.valueOf()) ?
                                                          prevEnd : currEnd;

                var newRange = (dateMatches(minStart, maxEnd)) ?
                                                minStart : [minStart, maxEnd];
                collapsed[collapsed.length-1] = newRange;
            }
            // if we don't collapse, just add to list
            else{
                collapsed.push(currRange);
            }
        }
        return collapsed;
    }


    /** Calendar._sanitizeChosenRanges:
            ((Date/[Date,Date]) array, Date) => (Date/[Date,Date]) array

    given a chosen range list or chosen date and an optional view date
    return the range list as the chosen date range,
    depending on what information is given

    if chosenrange is given as a valid date, return it as a singleton list
    if chosenrange is given as a valid date/daterange list, return it

    otherwise, return the given view date in a singleton list, or an empty list
    if the view is invalid or chosen is specifically set to nothing

    params:
        chosenRanges                either a single date or a list of
                                    Date/[Date,Date] ranges to sanitize
                                    if set to null or undefined, this is
                                    interpreted as an empty list

        viewDate                    (optional) the current cursor date
                                    (default = this.view)
    **/
    CALENDAR_PROTOTYPE._sanitizeChosenRanges = function(chosenRanges,
                                                              viewDate)
    {
        viewDate = (viewDate === undefined) ? this.view : viewDate;

        var cleanRanges;
        if(isValidDateObj(chosenRanges)){
            cleanRanges = [chosenRanges];
        }
        else if(isArray(chosenRanges)){
            cleanRanges = chosenRanges;
        }
        else if(chosenRanges === null || chosenRanges === undefined ||
                !viewDate)
        {
            cleanRanges = [];
        }
        else{
            cleanRanges = [viewDate];
        }

        var collapsedRanges = _collapseRanges(cleanRanges);
        // if multiple is not active, only get the first date of the chosen
        // ranges for the sanitize range list
        if((!this.multiple) && collapsedRanges.length > 0){
            var firstRange = collapsedRanges[0];

            if(isValidDateObj(firstRange)){
                return [firstRange];
            }
            else{
                return [firstRange[0]];
            }
        }
        else{
            return collapsedRanges;
        }
    };


    /** Calendar.addDate: (Date, Boolean)

    if append is falsy/not given, replaces the calendar's chosen ranges with
    the given date

    if append is truthy, adds the given date to the stored list of date ranges
    **/
    CALENDAR_PROTOTYPE.addDate = function(dateObj, append){
        if(isValidDateObj(dateObj)){
            if(append){
                this.chosen.push(dateObj);
                // trigger setter
                this.chosen = this.chosen;
            }
            else{
                this.chosen = [dateObj];
            }
        }
    };

    /** Calendar.removeDate: (Date)

    removes the given date from the Calendar's stored chosen date ranges
    **/
    CALENDAR_PROTOTYPE.removeDate = function(dateObj){
        if(!isValidDateObj(dateObj)){
            return;
        }
        // search stored chosen ranges for the given date to remove
        var ranges = this.chosen.slice(0);
        for(var i = 0; i < ranges.length; i++){
            var range = ranges[i];
            if(dateMatches(dateObj, [range])){
                // remove the item the date was found in
                ranges.splice(i, 1);

                // if the date was located in a 2-item date range, split the
                // range into separate ranges/dates as needed
                if(isArray(range)){
                    var rangeStart = range[0];
                    var rangeEnd = range[1];
                    var prevDate = prevDay(dateObj);
                    var nextDate = nextDay(dateObj);

                    // if we should keep the preceding section of the range
                    if(dateMatches(prevDate, [range])){
                        ranges.push([rangeStart, prevDate]);
                    }

                    // if we should keep the succeeding section of the range
                    if(dateMatches(nextDate, [range])){
                        ranges.push([nextDate, rangeEnd]);
                    }
                }
                this.chosen = _collapseRanges(ranges);
                break;
            }
        }
    };

    /** Calendar.hasChosenDate: (Date) => Boolean

    returns true if the given date is one of the dates stored as chosen
    **/
    CALENDAR_PROTOTYPE.hasChosenDate = function(dateObj){
        return dateMatches(dateObj, this._chosenRanges);
    };


    /** Calendar.hasVisibleDate: (Date, Boolean)

    if excludeBadMonths is falsy/not given, return true if the given date is
    at all visible in the calendar element, including the remnants of
    months visible on the edges of the current span

    if excludeBadMonths is truthy, return true if the given date is contained
    within the current visible span of dates, ignoring those in months not
    actually within the span
    **/
    CALENDAR_PROTOTYPE.hasVisibleDate = function(dateObj, excludeBadMonths){
        var startDate = (excludeBadMonths) ? this.firstVisibleMonth :
                                             this.firstVisibleDate;
        var endDate = (excludeBadMonths) ? findLast(this.lastVisibleMonth) :
                                           this.lastVisibleDate;

        return dateMatches(dateObj, [[startDate, endDate]]);
    };


    /** Calendar.render: (Boolean)

    Updates the DOM nodes stored in the current calendar

    if preserveNodes is falsy/not given, removes all existing nodes and
    completely recreates the calendar
       - use this when switching calendar displays, such as when changing span
         or using view to switch months
       - NOTE: throwing away nodes during an event handler kills the
         propagation chain, so account for this

    if preserveNodes is truthy, only update the status/classes of the currently
    displayed day nodes

    NOTE: this doesn't update the navigation controls, as they are separate from
    the calendar element
    **/
    CALENDAR_PROTOTYPE.render = function(preserveNodes){
        var span = this._span;
        var i;
        if(!preserveNodes){
            this.el.innerHTML = "";
            // get first month of the span of months centered on the view
            var ref = this.firstVisibleMonth;
            for (i = 0; i < span; i++) {
                appendChild(this.el, this.makeMonth(ref));
                // get next month's date
                ref = relOffset(ref, 0, 1, 0);
            }
        }
        // if we want to maintain the original elements without completely
        // wiping and rewriting nodes (ex: when the visible dates don't change)
        else{
            var days = xtag.query(this.el, ".day");
            var day;
            for(i = 0; i < days.length; i++){
                day = days[i];

                if(!day.hasAttribute("data-date")){
                    continue;
                }

                var dateIso = day.getAttribute("data-date");
                var parsedDate = fromIso(dateIso);
                if(!parsedDate){
                    continue;
                }
                else{
                    if(dateMatches(parsedDate, this._chosenRanges)){
                        addClass(day, CHOSEN_CLASS);
                    }
                    else{
                        removeClass(day, CHOSEN_CLASS);
                    }

                    if(dateMatches(parsedDate, [TODAY])){
                        addClass(day, "today");
                    }
                    else{
                        removeClass(day, "today");
                    }
                }
            }
        }

        // finally call the custom renderer
        this._callCustomRenderer();
    };

    // call custom renderer on each day, passing in the element, the
    // date, and the iso representation of the date
    CALENDAR_PROTOTYPE._callCustomRenderer = function(){
        if(!this._customRenderFn) return;

        // prevent infinite recursion of custom rendering requiring a rerender
        // of the calendar
        if(this._renderRecursionFlag){
            throw ("Error: customRenderFn causes recursive loop of "+
                   "rendering calendar; make sure your custom rendering "+
                   "function doesn't modify attributes of the x-calendar that "+
                   "would require a re-render!");
        }

        var days = xtag.query(this.el, ".day");
        for (var i = 0; i < days.length; i++) {
            var day = days[i];
            var dateIso = day.getAttribute("data-date");
            var parsedDate = fromIso(dateIso);

            this._renderRecursionFlag = true;
            this._customRenderFn(day,
                                 (parsedDate) ? parsedDate : null,
                                 dateIso);
            this._renderRecursionFlag = false;
        }
    };

    Object.defineProperties(CALENDAR_PROTOTYPE, {
        /** Calendar.el: (readonly)

        the DOM element representing the calendar's contianer element

        Note that this is the .calendar child div, NOT the x-calendar itself!

        (Controls are separated in order to prevent the need for constant
         layout repositioning due to z-indexing)
        **/
        "el": {
            get: function(){
                return this._el;
            }
        },

        /** Calendar.multiple: (read-writeable)

        a boolean value determining if multiple dates can be chosen
        simultaneously
        **/
        "multiple": {
            get: function(){
                return this._multiple;
            },
            set: function(multi){
                this._multiple = multi;
                this.chosen = this._sanitizeChosenRanges(this.chosen);
                this.render(true);
            }
        },

        /** Calendar.span: (read-writeable)

        the number of months to show in the calendar display
        **/
        "span":{
            get: function(){
                return this._span;
            },
            set: function(newSpan){
                var parsedSpan = parseIntDec(newSpan);
                if(!isNaN(parsedSpan) && parsedSpan >= 0){
                    this._span = parsedSpan;
                }
                else{
                    this._span = 0;
                }
                this.render(false);
            }
        },

        /** Calendar.view: (read-writeable)

        the cursor date to center the calendar display on
        **/
        "view":{
            attribute: {},
            get: function(){
                return this._viewDate;
            },
            set: function(rawViewDate){
                var newViewDate = this._sanitizeViewDate(rawViewDate);
                var oldViewDate = this._viewDate;
                this._viewDate = newViewDate;

                this.render(getMonth(oldViewDate) === getMonth(newViewDate) &&
                            getYear(oldViewDate) === getYear(newViewDate));
            }
        },

        /** Calendar.chosen: (read-writeable)

        the Date/[Date,Date] array representing the dates currently marked
        as chosen

        setter can take a date or a Date/[Date,Date] array
        (null is interpreted as an empty array)
        **/
        "chosen": {
            get: function(){
                return this._chosenRanges;
            },
            set: function(newChosenRanges){
                this._chosenRanges =
                        this._sanitizeChosenRanges(newChosenRanges);
                this.render(true);
            }
        },

        "firstWeekdayNum": {
            get: function(){
                return this._firstWeekdayNum;
            },
            set: function(weekdayNum){
                weekdayNum = parseIntDec(weekdayNum);
                if(!isWeekdayNum(weekdayNum)){
                    weekdayNum = 0;
                }
                this._firstWeekdayNum = weekdayNum;
                this.render(false);
            }
        },

        "lastWeekdayNum": {
            get: function(){
                return (this._firstWeekdayNum + 6) % 7;
            }
        },

        /** Calendar.customRenderFn: (read-writable)

        a function taking in a day element, its corresponding Date object,
        and the iso string corresponding to this date
        used to apply any user-defined rendering to the days in the element
        **/
        "customRenderFn": {
            get: function(){
                return this._customRenderFn;
            },
            set: function(newRenderFn){
                this._customRenderFn = newRenderFn;
                this.render(true);
            }
        },

        /** Calendar.chosenString: (readonly)

        an attribute safe string representing the currently chosen range of
        dates (ie: the JSON string representing it)
        **/
        "chosenString":{
            get: function(){
                if(this.multiple){
                    var isoDates = this.chosen.slice(0);

                    for(var i=0; i < isoDates.length; i++){
                        var range = isoDates[i];
                        if(isValidDateObj(range)){
                            isoDates[i] = iso(range);
                        }
                        else{
                            isoDates[i] = [iso(range[0]), iso(range[1])];
                        }
                    }
                    return JSON.stringify(isoDates);
                }
                else if(this.chosen.length > 0){
                    return iso(this.chosen[0]);
                }
                else{
                    return "";
                }
            }
        },

        /** Calendar.firstVisibleMonth: (readonly)

        gets the Date of the first day in the
        first month out of those included in the calendar span
        **/
        "firstVisibleMonth": {
            get: function(){
                return findFirst(
                         relOffset(this.view, 0, -Math.floor(this.span/2), 0)
                       );
            }
        },

        /** Calendar.lastVisibleMonth: (readonly)

        gets the Date of the first day in the
        last month out of those included in the calendar span
        **/
        "lastVisibleMonth": {
            get: function(){
                return relOffset(this.firstVisibleMonth, 0,
                                 Math.max(0, this.span-1), 0);
            }
        },

        "firstVisibleDate": {
            get: function(){
                return findWeekStart(this.firstVisibleMonth,
                                     this.firstWeekdayNum);
            }
        },

        "lastVisibleDate": {
            get: function(){
                return findWeekEnd(findLast(this.lastVisibleMonth),
                                   this.lastWeekdayNum);
            }
        },

        "labels": {
            get: function(){
                return this._labels;
            },
            set: function(newLabelData){
                var oldLabelData = this.labels;
                for(var labelType in oldLabelData){
                    if(!(labelType in newLabelData)) continue;

                    var oldLabel = this._labels[labelType];
                    var newLabel = newLabelData[labelType];
                    // if the old label data used an array of labels for a
                    // certain type of label, ensure that
                    // the replacement labels are also an array of the same
                    // number of labels
                    if(isArray(oldLabel)){
                        if(isArray(newLabel) &&
                           oldLabel.length === newLabel.length)
                        {
                            newLabel = newLabel.slice(0);
                            for (var i = 0; i < newLabel.length; i++) {
                                // check for existing builtin toString for
                                // string casting optimization
                                newLabel[i] = (newLabel[i].toString) ?
                                                newLabel[i].toString() :
                                                String(newLabel[i]);
                            }
                        }
                        else{
                            throw("invalid label given for '"+labelType+
                                  "': expected array of "+ oldLabel.length +
                                  " labels, got " + JSON.stringify(newLabel));
                        }
                    }
                    else{
                        newLabel = String(newLabel);
                    }
                    oldLabelData[labelType] = newLabel;
                }
                this.render(false);
            }
        }
    });

    /** _onDragStart: (x-calendar DOM, Date)

    when called, sets xCalendar to begin tracking a drag operation

    also toggles the given day if allowed
    **/
    function _onDragStart(xCalendar, day){
        var isoDate = day.getAttribute("data-date");
        var dateObj = parseSingleDate(isoDate);
        var toggleEventName;
        if(hasClass(day, CHOSEN_CLASS)){
            xCalendar.xtag.dragType = DRAG_REMOVE;
            toggleEventName = "datetoggleoff";
        }
        else{
            xCalendar.xtag.dragType = DRAG_ADD;
            toggleEventName = "datetoggleon";
        }
        xCalendar.xtag.dragStartEl = day;
        xCalendar.xtag.dragAllowTap = true;

        if(!xCalendar.noToggle){
            xtag.fireEvent(xCalendar, toggleEventName,
                           {detail: {date: dateObj, iso: isoDate}});
        }

        xCalendar.setAttribute("active", true);
        day.setAttribute("active", true);
    }

    /** _onDragMove: (x-calendar DOM, Date)

    when called, handles toggling behavior for the given day if needed
    when drag-painted over

    sets active attribute for the given day as well, if currently dragging
    **/
    function _onDragMove(xCalendar, day){
        var isoDate = day.getAttribute("data-date");
        var dateObj = parseSingleDate(isoDate);
        if(day !== xCalendar.xtag.dragStartEl){
            xCalendar.xtag.dragAllowTap = false;
        }

        if(!xCalendar.noToggle){
            // trigger a selection if we enter a nonchosen day while in
            // addition mode
            if(xCalendar.xtag.dragType === DRAG_ADD &&
               !(hasClass(day, CHOSEN_CLASS)))
            {
                xtag.fireEvent(xCalendar, "datetoggleon",
                               {detail: {date: dateObj, iso: isoDate}});
            }
            // trigger a remove if we enter a chosen day while in
            // removal mode
            else if(xCalendar.xtag.dragType === DRAG_REMOVE &&
                    hasClass(day, CHOSEN_CLASS))
            {
                xtag.fireEvent(xCalendar, "datetoggleoff",
                               {detail: {date: dateObj, iso: isoDate}});
            }
        }
        if(xCalendar.xtag.dragType){
            day.setAttribute("active", true);
        }
    }

    /** _onDragEnd

    when called, ends any drag operations of any x-calendars in the document
    **/
    function _onDragEnd(e){
        var xCalendars = xtag.query(document, "x-calendar");
        for(var i = 0; i < xCalendars.length; i++){
            var xCalendar = xCalendars[i];
            xCalendar.xtag.dragType = null;
            xCalendar.xtag.dragStartEl = null;
            xCalendar.xtag.dragAllowTap = false;
            xCalendar.removeAttribute("active");
        }

        var days = xtag.query(document, "x-calendar .day[active]");
        for(var j=0; j < days.length; j++){
            days[j].removeAttribute("active");
        }
    }

    /* _pointIsInRect: (Number, Number, {left: number, top: number,
                                         right: number, bottom: number})
    */
    function _pointIsInRect(x, y, rect){
        return (rect.left <= x && x <= rect.right &&
                rect.top <= y && y <= rect.bottom);
    }

    // added on the body to delegate dragends to all x-calendars
    var DOC_MOUSEUP_LISTENER = null;
    var DOC_TOUCHEND_LISTENER = null;

    xtag.register("x-calendar", {
        lifecycle: {
            created: function(){
                this.innerHTML = "";

                var chosenRange = this.getAttribute("chosen");
                this.xtag.calObj = new Calendar({
                    span: this.getAttribute("span"),
                    view: parseSingleDate(this.getAttribute("view")),
                    chosen: parseMultiDates(chosenRange),
                    multiple: this.hasAttribute("multiple"),
                    firstWeekdayNum : this.getAttribute("first-weekday-num")
                });
                appendChild(this, this.xtag.calObj.el);

                this.xtag.calControls = null;

                // used to track if we are currently in a dragging operation,
                // and if so, what type
                this.xtag.dragType = null;
                // used to track if we've entered any other elements
                // so that "tap" isn't fired on a drag
                this.xtag.dragStartEl = null;
                this.xtag.dragAllowTap = false;
            },

            // add the global listeners only once
            inserted: function(){
                if(!DOC_MOUSEUP_LISTENER){
                    DOC_MOUSEUP_LISTENER = xtag.addEvent(document, "mouseup",
                                                         _onDragEnd);
                }
                if(!DOC_TOUCHEND_LISTENER){
                    DOC_TOUCHEND_LISTENER = xtag.addEvent(document, "touchend",
                                                          _onDragEnd);
                }
                this.render(false);
            },
            // remove the global listeners only if no calendars exist in the
            // document anymore
            removed: function(){
                if(xtag.query(document, "x-calendar").length === 0){
                    if(DOC_MOUSEUP_LISTENER){
                        xtag.removeEvent(document, "mouseup",
                                         DOC_MOUSEUP_LISTENER);
                        DOC_MOUSEUP_LISTENER = null;
                    }
                    if(DOC_TOUCHEND_LISTENER){
                        xtag.removeEvent(document, "touchend",
                                         DOC_TOUCHEND_LISTENER);
                        DOC_TOUCHEND_LISTENER = null;
                    }
                }
            }
        },
        events: {
            // when clicking the 'next' control button
            "tap:delegate(.next)": function(e){
                var xCalendar = e.currentTarget;
                xCalendar.nextMonth();

                xtag.fireEvent(xCalendar, "nextmonth");
            },

            // when clicking the 'previous' control button
            "tap:delegate(.prev)": function(e){
                var xCalendar = e.currentTarget;
                xCalendar.prevMonth();

                xtag.fireEvent(xCalendar, "prevmonth");
            },

            "tapstart:delegate(.day)": function(e){
                // prevent firing on right click
                if((!e.touches) && e.button && e.button !== LEFT_MOUSE_BTN){
                    return;
                }
                 // prevent dragging around existing selections
                 // also prevent mobile drag scroll
                e.preventDefault();
                if(e.baseEvent) e.baseEvent.preventDefault();
                _onDragStart(e.currentTarget, this);
            },

            // touch drag move, firing toggles on newly entered dates if needed
            "touchmove": function(e){
                if(!(e.touches && e.touches.length > 0)){
                    return;
                }

                var xCalendar = e.currentTarget;
                if(!xCalendar.xtag.dragType){
                    return;
                }

                var touch = e.touches[0];
                var days = xtag.query(xCalendar, ".day");
                for (var i = 0; i < days.length; i++) {
                    var day = days[i];
                    if(_pointIsInRect(touch.pageX, touch.pageY, getRect(day))){
                        _onDragMove(xCalendar, day);
                    }
                    else{
                        day.removeAttribute("active");
                    }
                }
            },

            // mouse drag move, firing toggles on newly entered dates if needed
            "mouseover:delegate(.day)": function(e){
                var xCalendar = e.currentTarget;
                var day = this;

                _onDragMove(xCalendar, day);
            },
            "mouseout:delegate(.day)": function(e){
                var day = this;
                day.removeAttribute("active");
            },

            // if day is actually tapped, fire a datetap event
            "tapend:delegate(.day)": function(e){
                var xCalendar = e.currentTarget;

                // make sure that we can actually consider this a tap
                // (note that this delegated version fires before the
                //  mouseup/touchend events we assigned to the document)
                if(!xCalendar.xtag.dragAllowTap){
                    return;
                }
                var day = this;
                var isoDate = day.getAttribute("data-date");
                var dateObj = parseSingleDate(isoDate);

                xtag.fireEvent(xCalendar, "datetap",
                               {detail: {date: dateObj, iso: isoDate}});
            },

            "datetoggleon": function(e){
                var xCalendar = this;
                xCalendar.toggleDateOn(e.detail.date, xCalendar.multiple);
            },

            "datetoggleoff": function(e){
                var xCalendar = this;
                xCalendar.toggleDateOff(e.detail.date);
            }
        },
        accessors: {
            // handles if the x-calendar should display navigation controls or
            // not
            controls: {
                attribute: {boolean: true},
                set: function(hasControls){
                    if(hasControls && !this.xtag.calControls){
                        this.xtag.calControls = makeControls(this.xtag.calObj.labels);
                        // append controls AFTER calendar to use natural stack
                        // order instead of needing explicit z-index
                        appendChild(this, this.xtag.calControls);
                    }
                }
            },
            // handles if the x-calendar should allow multiple dates to be
            // chosen at once
            multiple: {
                attribute: {boolean: true},
                get: function(){
                    return this.xtag.calObj.multiple;
                },
                set: function(multi){
                    this.xtag.calObj.multiple = multi;
                    this.chosen = this.chosen;
                }
            },
            // handles how many months the x-calendar displays at once
            span: {
                attribute: {},
                get: function(){
                    return this.xtag.calObj.span;
                },
                set: function(newCalSpan){
                    this.xtag.calObj.span = newCalSpan;
                }
            },
            // handles where the x-calendar's display is focused
            view: {
                attribute: {},
                get: function(){
                    return this.xtag.calObj.view;
                },
                set: function(newView){
                    var parsedDate = parseSingleDate(newView);
                    if(parsedDate){
                        this.xtag.calObj.view = parsedDate;
                    }
                }
            },
            // handles which dates are marked as chosen in the x-calendar
            // setter can take a parseable string, a singular date, or a range
            // of dates/dateranges
            chosen: {
                attribute: {skip: true},
                get: function(){
                    var chosenRanges = this.xtag.calObj.chosen;
                    // return a single date if multiple selection not allowed
                    if(!this.multiple){
                        if(chosenRanges.length > 0){
                            var firstRange = chosenRanges[0];
                            if(isValidDateObj(firstRange)){
                                return firstRange;
                            }
                            else{
                                return firstRange[0];
                            }
                        }
                        else{
                            return null;
                        }
                    }
                    // otherwise return the entire selection list
                    else{
                        return this.xtag.calObj.chosen;
                    }
                },
                set: function(newDates){
                    var parsedDateRanges = (this.multiple) ?
                                            parseMultiDates(newDates) :
                                            parseSingleDate(newDates);
                    if(parsedDateRanges){
                        this.xtag.calObj.chosen = parsedDateRanges;
                    }
                    else{
                        this.xtag.calObj.chosen = null;
                    }

                    if(this.xtag.calObj.chosenString){
                        // override attribute with auto-generated string
                        this.setAttribute("chosen",
                                          this.xtag.calObj.chosenString);
                    }
                    else{
                        this.removeAttribute("chosen");
                    }
                }
            },

            // handles which day to use as the first day of the week
            firstWeekdayNum: {
                attribute: {name: "first-weekday-num"},
                set: function(weekdayNum){
                    this.xtag.calObj.firstWeekdayNum = weekdayNum;
                }
            },

            // handles if the x-calendar allows dates to be chosen or not
            // ie: if set, overrides default chosen-toggling behavior of the UI
            noToggle: {
                attribute: {boolean: true, name: "notoggle"},
                set: function(toggleDisabled){
                    if(toggleDisabled){
                        this.chosen = null;
                    }
                }
            },

            // (readonly) retrieves the first day in the first fully-visible
            // month of the calendar
            firstVisibleMonth: {
                get: function(){
                    return this.xtag.calObj.firstVisibleMonth;
                }
            },

            // (readonly) retrieves the first day in the last fully-visible
            // month of the calendar
            lastVisibleMonth: {
                get: function(){
                    return this.xtag.calObj.lastVisibleMonth;
                }
            },

            // (readonly) retrieves the first day in the calendar, even if it
            // is not part of a fully visible month
            firstVisibleDate: {
                get: function(){
                    return this.xtag.calObj.firstVisibleDate;
                }
            },

            // (readonly) retrieves the last day in the calendar, even if it
            // is not part of a fully visible month
            lastVisibleDate: {
                get: function(){
                    return this.xtag.calObj.lastVisibleDate;
                }
            },

            /** a function taking the following parameters:
               - a html element representing a day in the calendar
               - its corresponding Date object
               - the iso string corresponding to this Date

            this custom function is called whenever the calendar needs to be
            rendered, and is used to provide more flexibility in dynamically
            styling days of the calendar

            IMPORTANT NOTE: because this is called whenever the calendar is
            rendered, and because most calendar attribute changes
            **/
            customRenderFn: {
                get: function(){
                    return this.xtag.calObj.customRenderFn;
                },
                set: function(newRenderFn){
                    this.xtag.calObj.customRenderFn = newRenderFn;
                }
            },

            labels: {
                get: function(){
                    // clone labels to prevent user from clobbering aliases
                    return JSON.parse(JSON.stringify(this.xtag.calObj.labels));
                },
                // if given a datamap of labels whose keys match those in
                // DEFAULT_LABELS, reassign the labels using those in the given
                // newLabelData. Ensures that labels that were initially strings
                // stay strings, and that labels that were initially arrays of
                // strings stay arrays of strings (with the same # of elements)
                set: function(newLabelData){
                    this.xtag.calObj.labels = newLabelData;
                    var labels = this.xtag.calObj.labels;
                    // also update the control labels, if available
                    var prevControl = this.querySelector(".controls > .prev");
                    if(prevControl) prevControl.textContent = labels.prev;

                    var nextControl = this.querySelector(".controls > .next");
                    if(nextControl) nextControl.textContent = labels.next;
                }
            }
        },
        methods: {
            // updates the x-calendar display, recreating nodes if preserveNodes
            // if falsy or not given
            render: function(preserveNodes){
                this.xtag.calObj.render(preserveNodes);
            },

            // Go back one month by updating the view attribute of the calendar
            prevMonth: function(){
                var calObj = this.xtag.calObj;
                calObj.view = relOffset(calObj.view, 0, -1, 0);
            },

            // Advance one month forward by updating the view attribute
            // of the calendar
            nextMonth: function(){
                var calObj = this.xtag.calObj;
                calObj.view = relOffset(calObj.view, 0, 1, 0);
            },

            // sets the given date as chosen, either overriding the current
            // chosen dates if append is falsy or not given, or adding to the
            // list of chosen dates, if append is truthy
            // also updates the chosen attribute of the calendar
            toggleDateOn: function(newDateObj, append){
                this.xtag.calObj.addDate(newDateObj, append);
                // trigger setter
                this.chosen = this.chosen;
            },

            // removes the given date from the chosen list
            // also updates the chosen attribute of the calendar
            toggleDateOff: function(dateObj){
                this.xtag.calObj.removeDate(dateObj);
                // trigger setter
                this.chosen = this.chosen;
            },

            // switches the chosen status of the given date
            // 'appendIfAdd' specifies how the date is added to the list of
            // chosen dates if toggled on
            // also updates the chosen attribute of the calendar
            toggleDate: function(dateObj, appendIfAdd){
                if(this.xtag.calObj.hasChosenDate(dateObj)){
                    this.toggleDateOff(dateObj);
                }
                else{
                    this.toggleDateOn(dateObj, appendIfAdd);
                }
            },

            // returns whether or not the given date is in the visible
            // calendar display, optionally ignoring dates outside of the
            // month span
            hasVisibleDate: function(dateObj, excludeBadMonths){
                return this.xtag.calObj.hasVisibleDate(dateObj,
                                                       excludeBadMonths);
            }
        }
    });

})();