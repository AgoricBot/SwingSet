import harden from '@agoric/harden';
import Nat from '@agoric/nat';
import { makeLiveSlots } from './liveSlots';
import { QCLASS, makeMarshal } from './marshal';
import makePromise from './makePromise';

export default function buildKernel(kernelEndowments) {
  const { setImmediate } = kernelEndowments;

  const log = [];

  let running = false;

  // 'id' is always a non-negative integer (a Nat)
  // 'slot' is a type(string)+id, plus maybe a vatid (string)
  // * 'relative slot' lacks a vatid because it is implicit
  //    used in syscall.send and dispatch.deliver
  // * 'absolute slot' includes an explicit vatid
  //    used in kernel's runQueue
  // 'slots' is an array of 'slot', in send/deliver
  // 'slotIndex' is an index into 'slots', used in serialized JSON

  // key = `${type}.${toVatID}.${slotID}`
  // vats[vatid] = { imports: { inbound[key] = importID,
  //                            outbound[importID] = slot, },
  //                 nextImportID,
  //                 promises: { inbound[kernelPromiseID] = id,
  //                             outbound[id] = kernelPromiseID, },
  //                 nextPromiseID,
  //                 resolvers: { inbound[kernelPromiseID] = id,
  //                              outbound[id] = kernelPromiseID, },
  //                 nextResolverID,
  //               }
  const vats = harden(new Map());

  // runQueue entries are {type, vatID, more..}. 'more' depends on type:
  // * deliver: facetID, method, argsString, slots
  // * notifyFulfillToData: kernelPromiseID, argData, slots
  const runQueue = [];

  // in the kernel table, promises and resolvers are both indexed by the same
  // value. kernelPromises[promiseID] = { decider, subscribers }
  const kernelPromises = harden(new Map());
  let nextPromiseIndex = 40;

  function getVat(vatID) {
    const vat = vats.get(vatID);
    if (vat === undefined) {
      throw new Error(`unknown vatID '${vatID}'`);
    }
    return vat;
  }

  function allocateKernelPromiseIndex() {
    const i = nextPromiseIndex;
    nextPromiseIndex += 1;
    return i;
  }

  function allocatePromiseIDForVat(vat) {
    const i = vat.nextPromiseID;
    vat.nextPromiseID += 1;
    return i;
  }

  function allocateResolverIDForVat(vat) {
    const i = vat.nextResolverID;
    vat.nextResolverID += 1;
    return i;
  }

  // we define three types of slot identifiers: inbound, neutral, outbound
  // * outbound is what syscall.send(slots=) contains, it is always scoped to
  //   the sending vat, and the values are {type, id}. 'type' is either
  //   'import' ("my import") or 'export'. Message targets are always imports.
  // * middle is stored in runQueue, and contains {type: export, vatID, slotID}
  // * inbound is passed into deliver(slots=), is always scoped to the
  //   receiving/target vat, and the values are {type, id} where 'type' is
  //   either 'export' (for arguments coming back home) or 'import' for
  //   arguments from other vats
  //
  // * To convert outbound->middle, we look up imports in kernelSlots, and
  //   just append the sending vatID to exports
  //
  // * To convert middle->inbound, we set attach type='export' when the vatID
  //   matches that of the receiving vat, and we look up the others in
  //   kernelSlots (adding one if necessary) to deliver type='import'

  // mapOutbound: convert fromVatID-relative slot to absolute slot. fromVatID
  // just did syscall.send and referenced 'slot' (in an argument, or as the
  // target of a send), what are they talking about?

  function mapOutbound(fromVatID, slot) {
    // console.log(`mapOutbound ${JSON.stringify(slot)}`);
    const vat = getVat(fromVatID);

    if (slot.type === 'export') {
      // one of fromVatID's exports, so just make the vatID explicit
      Nat(slot.id);
      return { type: 'export', vatID: fromVatID, id: slot.id };
    }

    if (slot.type === 'import') {
      // an import from somewhere else, so look in the sending Vat's table to
      // translate into absolute form
      Nat(slot.id);
      return vat.imports.outbound.get(slot.id);
    }

    if (slot.type === 'promise') {
      Nat(slot.id);
      if (!vat.promises.outbound.has(slot.id)) {
        throw new Error(`unknown promise slot '${slot.id}'`);
      }
      return { type: 'promise', id: vat.promises.outbound.get(slot.id) };
    }

    if (slot.type === 'resolver') {
      Nat(slot.id);
      if (!vat.resolvers.outbound.has(slot.id)) {
        throw new Error(`unknown resolver slot '${slot.id}'`);
      }
      return { type: 'resolver', id: vat.resolvers.outbound.get(slot.id) };
    }

    throw Error(`unknown slot.type '${slot.type}'`);
  }

  function allocateImportIndex(vatID) {
    const vat = getVat(vatID);
    const i = vat.nextImportID;
    vat.nextImportID = i + 1;
    return i;
  }

  // mapInbound: convert from absolute slot to forVatID-relative slot. This
  // is used when building the arguments for dispatch.deliver.
  function mapInbound(forVatID, slot) {
    // console.log(`mapInbound for ${forVatID} of ${slot}`);
    const vat = getVat(forVatID);

    if (slot.type === 'export') {
      const { vatID, id } = slot;
      Nat(id);

      if (vatID === forVatID) {
        // this is returning home, so it's one of the target's exports
        return { type: 'export', id };
      }

      const m = vat.imports;
      const key = `${slot.type}.${vatID}.${id}`; // ugh javascript
      if (!m.inbound.has(key)) {
        // must add both directions
        const newSlotID = Nat(allocateImportIndex(forVatID));
        // console.log(` adding ${newSlotID}`);
        m.inbound.set(key, newSlotID);
        m.outbound.set(newSlotID, harden({ type: 'export', vatID, id }));
      }
      return { type: 'import', id: m.inbound.get(key) };
    }

    if (slot.type === 'promise') {
      const kernelPromiseID = slot.id;
      Nat(kernelPromiseID);
      const m = vat.promises;
      if (!m.inbound.has(kernelPromiseID)) {
        const promiseID = Nat(allocatePromiseIDForVat(vat));
        m.inbound.set(kernelPromiseID, promiseID);
        m.outbound.set(promiseID, kernelPromiseID);
      }
      return { type: 'promise', id: m.inbound.get(kernelPromiseID) };
    }

    if (slot.type === 'resolver') {
      const kernelPromiseID = slot.id;
      Nat(kernelPromiseID);
      const m = vat.resolvers;
      if (!m.inbound.has(kernelPromiseID)) {
        const resolverID = Nat(allocateResolverIDForVat(vat));
        m.inbound.set(kernelPromiseID, resolverID);
        m.outbound.set(resolverID, kernelPromiseID);
      }
      return { type: 'resolver', id: m.inbound.get(kernelPromiseID) };
    }

    throw Error(`unknown type '${slot.type}'`);
  }

  function chaseRedirections(promiseID) {
    let targetID = Nat(promiseID);
    while (true) {
      const p = kernelPromises.get(targetID);
      if (p.state === 'redirected') {
        targetID = Nat(p.redirectedTo);
        continue;
      }
      return targetID;
    }
  }

  const syscallBase = harden({
    send(fromVatID, targetImportID, method, argsString, vatSlots) {
      Nat(targetImportID);
      const target = mapOutbound(fromVatID, {
        type: 'import',
        id: targetImportID,
      });
      if (!target)
        throw Error(`unable to find target for ${fromVatID}/${targetImportID}`);
      const slots = vatSlots.map(slot => mapOutbound(fromVatID, slot));
      runQueue.push({
        type: 'deliver',
        vatID: target.vatID,
        facetID: target.id,
        method,
        argsString,
        slots,
      });
    },

    createPromise(fromVatID) {
      const promiseID = allocateKernelPromiseIndex();
      // we don't harden the kernel promise record because it is mutable: it
      // can be replaced when syscall.redirect/fulfill/reject is called
      kernelPromises.set(promiseID, {
        state: 'unresolved',
        decider: fromVatID,
        subscribers: new Set(),
      });
      const p = mapInbound(fromVatID, {
        type: 'promise',
        id: promiseID,
      });
      const r = mapInbound(fromVatID, {
        type: 'resolver',
        id: promiseID,
      });
      return { promiseID: p.id, resolverID: r.id };
    },

    subscribe(fromVatID, promiseID) {
      const { id } = mapOutbound(fromVatID, { type: 'promise', id: promiseID });
      if (!kernelPromises.has(id)) {
        throw new Error(`unknown kernelPromise id '${id}'`);
      }
      const p = kernelPromises.get(id);
      p.subscribers.add(fromVatID);
    },

    /*
    redirect(fromVatID, resolverID, targetPromiseID) {
      const { id } = mapOutbound(fromVatID, { type: 'resolver', id: resolverID });
      if (!kernelPromises.has(id)) {
        throw new Error(`unknown kernelPromise id '${id}'`);
      }
      const p = kernelPromises.get(id);
      if (p.state !== 'unresolved') {
        throw new Error(`kernelPromise[${id}] is '${p.state}', not 'unresolved'`);
      }

      let { id: targetID } = mapOutbound(fromVatID, { type: 'promise', id: targetPromiseID });
      if (!kernelPromises.has(targetID)) {
        throw new Error(`unknown kernelPromise id '${targetID}'`);
      }

      targetID = chaseRedirections(targetID);
      const target = kernelPromises.get(targetID);

      for (let s of p.subscribers) {
        // TODO: we need to remap their subscriptions, somehow
      }

      p.state = 'redirected';
      delete p.decider;
      const subscribers = p.subscribers;
      delete p.subscribers;
      p.redirectedTo = targetID;
      if (p.state !== 'unresolved') {
        throw new Error(`kernelPromise[${id}] is '${p.state}', not 'unresolved'`);
      }
    },
    */

    fulfillToData(fromVatID, resolverID, fulfillData, vatSlots) {
      const { id } = mapOutbound(fromVatID, {
        type: 'resolver',
        id: resolverID,
      });
      if (!kernelPromises.has(id)) {
        throw new Error(`unknown kernelPromise id '${id}'`);
      }
      const p = kernelPromises.get(id);
      if (p.state !== 'unresolved') {
        throw new Error(
          `kernelPromise[${id}] is '${p.state}', not 'unresolved'`,
        );
      }
      p.state = 'fulfilledToData';
      p.fulfillData = fulfillData;
      p.fulfillSlots = vatSlots.map(slot => mapOutbound(fromVatID, slot));
      for (const subscriberVatID of p.subscribers) {
        runQueue.push({
          type: 'notifyFulfillToData',
          vatID: subscriberVatID,
          kernelPromiseID: id,
        });
      }
      delete p.subscribers;
      delete p.decider;
    },

    fulfillToTarget(fromVatID, resolverID, slot) {
      const { id } = mapOutbound(fromVatID, {
        type: 'resolver',
        id: resolverID,
      });
      if (!kernelPromises.has(id)) {
        throw new Error(`unknown kernelPromise id '${id}'`);
      }
      const p = kernelPromises.get(id);
      if (p.state !== 'unresolved') {
        throw new Error(
          `kernelPromise[${id}] is '${p.state}', not 'unresolved'`,
        );
      }
      const absoluteSlot = mapOutbound(fromVatID, slot);
      if (absoluteSlot.type !== 'export') {
        throw new Error(
          `fulfillToTarget() must fulfill to export, not ${absoluteSlot.type}`,
        );
      }

      p.state = 'fulfilledToTarget';
      p.fulfillSlot = absoluteSlot;
      for (const subscriberVatID of p.subscribers) {
        runQueue.push({
          type: 'notifyFulfillToTarget',
          vatID: subscriberVatID,
          kernelPromiseID: id,
        });
      }
      delete p.subscribers;
      delete p.decider;
    },

  });

  function syscallForVatID(fromVatID) {
    return harden({
      send(...args) {
        return syscallBase.send(fromVatID, ...args);
      },
      createPromise(...args) {
        return syscallBase.createPromise(fromVatID, ...args);
      },
      subscribe(...args) {
        return syscallBase.subscribe(fromVatID, ...args);
      },
      redirect(...args) {
        return syscallBase.redirect(fromVatID, ...args);
      },
      fulfillToData(...args) {
        return syscallBase.fulfillToData(fromVatID, ...args);
      },
      fulfillToTarget(...args) {
        return syscallBase.fulfillToTarget(fromVatID, ...args);
      },

      log(str) {
        log.push(`${str}`);
      },

      // TODO: this is temporary, obviously vats shouldn't be able to pause the kernel
      pause() {
        running = false;
      },
    });
    // TODO: since we pass this in on each deliver() call, consider
    // destroying this object after each delivery, to discourage vat code
    // from retaining it. OTOH if we don't expect to ever change it, that's
    // wasteful and limiting.
  }

  function addVat(vatID, setup) {
    if (vats.has(vatID)) {
      throw new Error(`already have a vat named '${vatID}'`);
    }
    const syscall = syscallForVatID(vatID);
    const helpers = harden({
      vatID,
      makeLiveSlots,
      log(str) {
        log.push(`${str}`);
      },
    });
    const dispatch = setup(syscall, helpers);
    // the vat record is not hardened: it holds mutable next-ID values
    vats.set(vatID, {
      id: vatID,
      dispatch,
      imports: harden({
        outbound: new Map(),
        inbound: new Map(),
      }),
      // make these IDs start at different values to detect errors better
      nextImportID: 10,
      promises: harden({
        outbound: new Map(),
        inbound: new Map(),
      }),
      nextPromiseID: 20,
      resolvers: harden({
        outbound: new Map(),
        inbound: new Map(),
      }),
      nextResolverID: 30,
    });
  }

  async function process(f, logerr) {
    // the delivery might cause some number of (native) Promises to be
    // created and resolved, so we use the IO queue to detect when the
    // Promise queue is empty. The IO queue (setImmediate and setTimeout) is
    // lower-priority than the Promise queue on browsers and Node 11, but on
    // Node 10 it is higher. So this trick requires Node 11.
    // https://jsblog.insiderattack.net/new-changes-to-timers-and-microtasks-from-node-v11-0-0-and-above-68d112743eb3

    const { p: queueEmptyP, res } = makePromise();
    setImmediate(() => res());

    // protect f() with promise/then
    Promise.resolve()
      .then(f)
      .then(undefined, logerr);
    await queueEmptyP;
  }

  async function processOneMessage(message) {
    // console.log(`process ${JSON.stringify(message)}`);
    const { type, vatID } = message;
    if (type === 'deliver') {
      const { dispatch } = getVat(vatID);
      const inputSlots = message.slots.map(slot => mapInbound(vatID, slot));
      return process(
        () =>
          dispatch.deliver(
            message.facetID,
            message.method,
            message.argsString,
            inputSlots,
          ),
        err =>
          console.log(
            `vat[${vatID}][${message.facetID}].${message.method} dispatch failed: ${err}`,
            err,
          ),
      );
    }

    if (type === 'notifyFulfillToData') {
      const { kernelPromiseID } = message;
      const { dispatch } = getVat(vatID);
      const p = kernelPromises.get(kernelPromiseID);
      const relativeID = mapInbound(vatID, {
        type: 'promise',
        id: kernelPromiseID,
      }).id;
      return process(
        () =>
          dispatch.notifyFulfillToData(
            relativeID,
            p.fulfillData,
            p.fulfillSlots.map(slot => mapInbound(vatID, slot)),
          ),
        err =>
          console.log(
            `vat[${vatID}].promise[${relativeID}] fulfillToData failed: ${err}`,
            err,
          ),
      );
    }

    if (type === 'notifyFulfillToTarget') {
      const { kernelPromiseID } = message;
      const { dispatch } = getVat(vatID);
      const p = kernelPromises.get(kernelPromiseID);
      const relativeID = mapInbound(vatID, {
        type: 'promise',
        id: kernelPromiseID,
      }).id;
      return process(
        () =>
          dispatch.notifyFulfillToTarget(
            relativeID,
            mapInbound(vatID, p.fulfillSlot),
          ),
        err =>
          console.log(
            `vat[${vatID}].promise[${relativeID}] fulfillToTarget failed: ${err}`,
            err,
          ),
      );
    }

    throw new Error(`unknown message type '${type}'`);
  }

  function addImport(forVatID, what) {
    return mapInbound(forVatID, what);
  }

  function mapQueueSlotToKernelRealm(s) {
    if (s.type === 'export') {
      return harden({
        type: `${s.type}`,
        vatID: `${s.vatID}`,
        id: Nat(s.id),
      });
    }
    throw Error(`unrecognized type '${s.type}'`);
  }

  function queue(vatID, facetID, method, argsString, slots = []) {
    // queue a message on the end of the queue, with 'absolute' slots. Use
    // 'step' or 'run' to execute it
    runQueue.push(
      harden({
        type: 'deliver',
        vatID: `${vatID}`,
        facetID: Nat(facetID), // always export
        method: `${method}`,
        argsString: `${argsString}`,
        // queue() is exposed to the controller's realm, so we must translate
        // each slot into a kernel-realm object/array
        slots: Array.from(slots.map(mapQueueSlotToKernelRealm)),
      }),
    );
  }

  function callBootstrap(vatID, argvString) {
    const argv = JSON.parse(`${argvString}`);
    // each key of 'vats' will be serialized as a reference to its obj0
    const vrefs = new Map();
    const vatObj0s = {};
    Array.from(vats.entries()).forEach(e => {
      const targetVatID = e[0];
      if (targetVatID !== vatID) {
        // don't give _bootstrap to itself
        const vref = harden({}); // marker
        vatObj0s[targetVatID] = vref;
        vrefs.set(vref, { type: 'export', vatID: targetVatID, id: 0 });
      }
    });

    function serializeSlot(vref, slots, slotMap) {
      if (!vrefs.has(vref)) {
        console.log(`oops ${vref}`, vref);
        throw Error('bootstrap got unexpected pass-by-presence');
      }
      if (!slotMap.has(vref)) {
        const slotIndex = slots.length;
        slots.push(vrefs.get(vref));
        slotMap.set(vref, slotIndex);
      }
      const slotIndex = slotMap.get(vref);
      return harden({ [QCLASS]: 'slot', index: slotIndex });
    }
    const m = makeMarshal(serializeSlot);
    const s = m.serialize(harden({ args: [argv, vatObj0s] }));
    // queue() takes 'neutral' { type: export, vatID, slotID } objects in s.slots
    queue(vatID, 0, 'bootstrap', s.argsString, s.slots);
  }

  const kernel = harden({
    addVat(vatID, setup) {
      harden(setup);
      // 'setup' must be an in-realm function. This test guards against
      // accidents, but not against malice. MarkM thinks there is no reliable
      // way to test this.
      if (!(setup instanceof Function)) {
        throw Error('setup is not an in-realm function');
      }
      addVat(`${vatID}`, setup);
    },

    callBootstrap,

    addImport,

    log(str) {
      log.push(`${str}`);
    },

    dump() {
      const vatTables = [];
      const kernelTable = [];

      vats.forEach((vat, vatID) => {
        // TODO: find some way to expose the liveSlots internal tables, the
        // kernel doesn't see them
        const vatTable = { vatID };
        vatTables.push(vatTable);

        vat.imports.outbound.forEach((target, slot) => {
          kernelTable.push([
            vatID,
            'import',
            slot,
            target.type,
            target.vatID,
            target.id,
          ]);
        });

        vat.promises.outbound.forEach((kernelPromiseID, promiseID) => {
          kernelTable.push([vatID, 'promise', promiseID, kernelPromiseID]);
        });
      });

      function compareNumbers(a, b) {
        return a - b;
      }

      function compareStrings(a, b) {
        if (a > b) {
          return 1;
        }
        if (a < b) {
          return -1;
        }
        return 0;
      }

      kernelTable.sort(
        (a, b) =>
          compareStrings(a[0], b[0]) ||
          compareStrings(a[1], b[1]) ||
          compareNumbers(a[2], b[2]) ||
          compareStrings(a[3], b[3]) ||
          compareNumbers(a[4], b[4]) ||
          compareNumbers(a[5], b[5]) ||
          0,
      );

      const promises = [];
      kernelPromises.forEach((p, id) => {
        const kp = Object.create(
          Object.prototype,
          Object.getOwnPropertyDescriptors(p),
        );
        kp.id = id;
        if ('subscribers' in p) {
          kp.subscribers = Array.from(p.subscribers); // turn Set into Array
        }
        promises.push(kp);
      });

      return { vatTables, kernelTable, promises, runQueue, log };
    },

    async run() {
      // process all messages, until syscall.pause() is invoked
      running = true;
      while (running && runQueue.length) {
        // eslint-disable-next-line no-await-in-loop
        await processOneMessage(runQueue.shift());
      }
    },

    async drain() {
      // process all existing messages, but stop before processing new ones
      running = true;
      let remaining = runQueue.length;
      while (running && remaining) {
        // eslint-disable-next-line no-await-in-loop
        await processOneMessage(runQueue.shift());
        remaining -= 1;
      }
    },

    async step() {
      // process a single message
      if (runQueue.length) {
        await processOneMessage(runQueue.shift());
      }
    },

    queue,
  });

  return kernel;
}
