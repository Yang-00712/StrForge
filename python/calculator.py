"""StrForge decimal calculation engine and line-delimited JSON worker."""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import json
import secrets
import sys

DISPLAY_UNIT = Decimal("0.00000001")


def number(value):
    if value is None:
        text = ""
    else:
        text = str(value).strip()
    text = text.replace("，", ".").replace("％", "").replace("%", "").replace(",", "")
    if text in ("", "-", "+", ".", "-.", "+."):
        return None
    if len(text) > 128:
        raise ValueError("數值過長。")
    try:
        parsed = Decimal(text)
    except (InvalidOperation, ValueError) as error:
        raise ValueError("請輸入有效數值。") from error
    if not parsed.is_finite() or (parsed != 0 and abs(parsed.adjusted()) > 24):
        raise ValueError("數值超出支援範圍（非零數值 1e-24 至 1e24）。")
    return parsed


def display(value):
    if value is None:
        return ""
    rounded = value.quantize(DISPLAY_UNIT, rounding=ROUND_HALF_UP)
    if rounded == 0:
        return "0"
    return format(rounded, "f").rstrip("0").rstrip(".")


def calculate(request):
    """Calculate with Decimal and return display strings for the UI boundary."""
    if not isinstance(request, dict):
        return {"id": 0, "values": {}, "error": "Request must be an object."}
    request_id = request.get("id", 0)
    output = {"id": request_id, "values": {}, "error": None}
    try:
        operation = request.get("operation")
        inputs = request.get("inputs", {})
        if not isinstance(operation, str) or not operation:
            raise ValueError("Operation must be a non-empty string.")
        if not isinstance(inputs, dict):
            raise ValueError("Inputs must be an object.")

        with localcontext() as context:
            context.prec = 80
            context.rounding = ROUND_HALF_UP
            get = lambda key: number(inputs.get(key, ""))
            out = output["values"]

            if operation == "difference":
                background, measurement = get("background"), get("measurement")
                out["difference"] = display(measurement - background) if None not in (background, measurement) else ""
            elif operation == "average":
                values = [get(key) for key in ("a", "b", "c")]
                out.update(average="", rounded="", ninety="")
                if None not in values:
                    average = sum(values) / Decimal(3)
                    rounded = average.quantize(Decimal(1), rounding=ROUND_HALF_UP)
                    out.update(average=display(average), rounded=display(rounded), ninety=display(rounded * Decimal("0.9")))
            elif operation == "concentration":
                basis = get("basis")
                samples = [get(key) for key in ("a", "b", "c")]
                out.update(sampleAverage="", abs1="", abs2="", abs3="", total="", averageDifference="", ratio="", percent="")
                if None not in samples:
                    out["sampleAverage"] = display(sum(samples) / Decimal(3))
                if basis is not None:
                    for index, sample in enumerate(samples, 1):
                        if sample is not None:
                            out["abs" + str(index)] = display(abs(sample - basis))
                    if None not in samples:
                        total = sum(abs(sample - basis) for sample in samples)
                        average = total / Decimal(3)
                        out.update(total=display(total), averageDifference=display(average))
                        if basis != 0:
                            out.update(ratio=display(average / basis), percent=display(average / basis * Decimal(100)))
                        else:
                            output["error"] = "濃度不可為 0。"
            elif operation == "compare":
                zero, span, basis = get("zero"), get("span"), get("basis")
                out.update(difference="", ratio="")
                if None not in (zero, span):
                    difference = span - zero
                    out["difference"] = display(difference)
                    if basis is not None:
                        if basis != 0:
                            out["ratio"] = display(difference / basis)
                        else:
                            output["error"] = "濃度不可為 0。"
            elif operation == "flow":
                setting = get("setting")
                values = [get("v" + str(index)) for index in range(1, 6)]
                out.update(average="", percent="", hasPercent="false")
                if None not in values:
                    average = sum(values) / Decimal(5)
                    out["average"] = display(average)
                    if setting is not None:
                        if setting != 0:
                            out.update(percent=display((average - setting) / setting * Decimal(100)) + "%", hasPercent="true")
                        else:
                            output["error"] = "設定 A 不可為 0。"
            elif operation == "random_t90":
                lower, upper = get("lower"), get("upper")
                if lower is None or upper is None:
                    raise ValueError("請先輸入上下限。")
                if lower > upper:
                    raise ValueError("下限不可大於上限。")
                places = max(0, -lower.normalize().as_tuple().exponent, -upper.normalize().as_tuple().exponent)
                if places > 3:
                    raise ValueError("上下限最多支援 3 位小數。")
                scale = Decimal(10) ** places
                low_integer, high_integer = int(lower * scale), int(upper * scale)
                for key in ("a", "b", "c"):
                    out[key] = display(Decimal(low_integer + secrets.randbelow(high_integer - low_integer + 1)) / scale)
            else:
                raise ValueError("不支援的計算項目。")
    except (ValueError, InvalidOperation, ArithmeticError, TypeError) as error:
        output["values"] = {}
        output["error"] = str(error) or "數值超出可計算範圍。"
    return output


def process_json(payload):
    try:
        request = json.loads(payload)
        response = calculate(request)
    except Exception as error:
        response = {"id": 0, "values": {}, "error": str(error) or "Invalid request."}
    return json.dumps(response, ensure_ascii=True, separators=(",", ":"))


def serve():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    print('{"ready":true,"protocol":1}', flush=True)
    for line in sys.stdin:
        if len(line) > 65536:
            print('{"id":0,"values":{},"error":"Request too large."}', flush=True)
            continue
        print(process_json(line), flush=True)


if __name__ == "__main__" and sys.platform != "emscripten":
    serve()
