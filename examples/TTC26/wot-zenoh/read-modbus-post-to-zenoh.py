import zenoh
import json
import time
import logging
from pymodbus.client import ModbusTcpClient

MODBUS_HOST = 'localhost'
MODBUS_PORT = 1502
UNIT_ID = 1
START_ADDRESS = 290
QUANTITY = 4
ZENOH_KEY = 'test/modbus'

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("logger")

def main():
    logger.info("Opening Zenoh session...")
    conf = zenoh.Config()
    conf.insert_json5("listen/endpoints", '["tcp/127.0.0.1:7447"]')
    
    z_session = zenoh.open(conf)

    logger.info(f"Connecting to Modbus TCP at {MODBUS_HOST}:{MODBUS_PORT}...")
    mb_client = ModbusTcpClient(MODBUS_HOST, port=MODBUS_PORT)

    try:
        while True:
            if not mb_client.connected:
                mb_client.connect()

            response = mb_client.read_holding_registers(
                address=START_ADDRESS, 
                count=QUANTITY, 
                device_id=UNIT_ID
            )

            if not response.isError():
                data = {
                    "timestamp": time.time(),
                    "values": response.registers
                }
                z_session.put(ZENOH_KEY, json.dumps(data))
                logger.info(f"Published: {response.registers}")
            else:
                logger.error(f"Modbus Error: {response}")

            time.sleep(2)

    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        mb_client.close()
        z_session.close()

if __name__ == "__main__":
    main()