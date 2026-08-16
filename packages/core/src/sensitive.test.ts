import { describe, expect, it } from "vitest";
import {
  guessSensitive,
  maskCellShape,
  piiScanIsClean,
  scanTextForPii,
} from "./sensitive.js";

describe("guessSensitive", () => {
  it("flags identifier fields by key or label", () => {
    expect(guessSensitive("tenant_ssn", "Tenant SSN")).toBe("ssn");
    expect(guessSensitive("x", "Social Security number")).toBe("ssn");
    expect(guessSensitive("company_ein", "Company EIN")).toBe("ein");
    expect(guessSensitive("x", "Employer Identification Number")).toBe("ein");
    expect(guessSensitive("tax_id", "Tax ID")).toBe("tax_id");
    expect(guessSensitive("routing_no", "Routing number")).toBe("bank");
    expect(guessSensitive("x", "Driver's license number")).toBe("license");
    expect(guessSensitive("dob", "Date of birth")).toBe("dob");
    expect(guessSensitive("card", "Credit card number")).toBe("card");
  });

  it("leaves ordinary contract fields alone", () => {
    expect(guessSensitive("monthly_rent", "Monthly rent amount")).toBeNull();
    expect(guessSensitive("occupant_email", "Renter's email address")).toBeNull();
    expect(guessSensitive("unit_number", "Storage unit number")).toBeNull();
    expect(guessSensitive("effective_date", "Effective date")).toBeNull();
    // "ein" inside a word must not match.
    expect(guessSensitive("rein_statement", "Reinstatement terms")).toBeNull();
  });
});

describe("maskCellShape", () => {
  it("preserves shape, destroys content", () => {
    expect(maskCellShape("123-45-6789")).toBe("###-##-####");
    expect(maskCellShape("sarah.chen@example.com")).toBe("xxxxx.xxxx@xxxxxxx.xxx");
    expect(maskCellShape("$3,500.00")).toBe("$#,###.##");
    expect(maskCellShape("2026-08-03")).toBe("####-##-##");
    expect(maskCellShape("Sarah Chen")).toBe("Xxxxx Xxxx");
  });

  it("caps runaway cells", () => {
    const long = "a".repeat(100);
    expect(maskCellShape(long).length).toBe(61); // 60 + ellipsis
  });
});

describe("scanTextForPii", () => {
  it("finds filled identifiers", () => {
    const scan = scanTextForPii(
      "SSN: 123-45-6789. EIN: 12-3456789. Card: 4539 1488 0343 6467.",
    );
    expect(scan.ssnLike).toBe(1);
    expect(scan.einLike).toBe(1);
    expect(scan.cardLike).toBe(1);
    expect(piiScanIsClean(scan)).toBe(false);
  });

  it("a blank template scans clean", () => {
    const scan = scanTextForPii(
      "SSN: ___-__-____. EIN: [EIN]. Card number: ____ ____ ____ ____." +
        " The fee is $4,500.00 payable by 2026-08-03.",
    );
    expect(piiScanIsClean(scan)).toBe(true);
  });

  it("random digit runs that fail Luhn are not cards", () => {
    expect(scanTextForPii("Ref 1234 5678 9012 3456").cardLike).toBe(0);
  });
});
