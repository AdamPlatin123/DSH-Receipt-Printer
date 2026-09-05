export function miniSchema(spec) {
    return {
        '~standard': {
            version: 1,
            vendor: 'dsh-thermal-receipt',
            validate(value) {
                if (value !== undefined && value !== null && typeof value !== 'object') {
                    return { issues: [{ message: `config must be an object, got ${typeof value}` }] };
                }
                const input = (value ?? {});
                const out = { ...spec.defaults };
                const issues = [];
                for (const key of Object.keys(spec.defaults)) {
                    if (!(key in input) || input[key] === undefined)
                        continue;
                    let v = input[key];
                    if (spec.booleans?.includes(key))
                        v = Boolean(v);
                    if (spec.numbers?.includes(key)) {
                        const n = Number(v);
                        if (Number.isNaN(n)) {
                            issues.push({ message: `config.${String(key)} must be a number, got ${JSON.stringify(v)}` });
                            continue;
                        }
                        v = n;
                    }
                    const allowed = spec.enums?.[key];
                    if (allowed && !allowed.includes(v)) {
                        issues.push({
                            message: `config.${String(key)} must be one of ${JSON.stringify(allowed)}, got ${JSON.stringify(v)}`,
                        });
                        continue;
                    }
                    out[key] = v;
                }
                if (issues.length > 0)
                    return { issues };
                return { value: out };
            },
        },
    };
}
