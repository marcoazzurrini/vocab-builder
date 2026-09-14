export class SyncConflict extends Error {
  constructor() {
    super(
      "I progressi sono cambiati su un altro dispositivo. Le risposte in attesa non sono state salvate.",
    );
  }
}
