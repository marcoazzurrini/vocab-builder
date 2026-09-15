// oxlint-disable-next-line unicorn/custom-error-definition -- Preserve the existing constructor name and serialized Error category.
export class SyncConflict extends Error {
  // oxlint-disable-next-line unicorn/custom-error-definition -- Existing consumers inherit Error.name instead of a new error category.
  constructor() {
    super(
      "I progressi sono cambiati su un altro dispositivo. Le risposte in attesa non sono state salvate."
    );
  }
}
