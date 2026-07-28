"""
Minimal Odoo XML-RPC client for the dashboard generator.

Adapted from the OdooClient in the sibling MCP server project (../outputs/server.py)
so both projects share the same auth/connection behaviour. This copy adds
read_group, since dashboards live and die on server-side aggregation.
"""

from __future__ import annotations

import os
import ssl
import xmlrpc.client
from functools import lru_cache
from typing import Any


class OdooError(RuntimeError):
    pass


class OdooClient:
    """Minimal XML-RPC client with lazy auth and a cached uid."""

    def __init__(self, url: str, db: str, username: str, password: str):
        self.url = url
        self.db = db
        self.username = username
        self.password = password
        self._uid: int | None = None
        # See ../outputs/server.py for why VERIFY_X509_STRICT is relaxed here:
        # this network's TLS-inspection appliance issues leaf certs missing the
        # Authority Key Identifier extension.
        self._ctx = ssl.create_default_context()
        self._ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        self._common = xmlrpc.client.ServerProxy(
            f"{url}/xmlrpc/2/common", context=self._ctx, allow_none=True
        )
        self._models = xmlrpc.client.ServerProxy(
            f"{url}/xmlrpc/2/object", context=self._ctx, allow_none=True
        )

    @property
    def uid(self) -> int:
        if self._uid is None:
            if not (self.username and self.password):
                raise OdooError(
                    "Missing credentials. Set ODOO_USERNAME and ODOO_PASSWORD "
                    "(or an API key) in the environment."
                )
            uid = self._common.authenticate(self.db, self.username, self.password, {})
            if not uid:
                raise OdooError(
                    "Authentication failed. Check ODOO_DB, ODOO_USERNAME and ODOO_PASSWORD."
                )
            self._uid = uid
        return self._uid

    def execute(self, model: str, method: str, *args, **kwargs) -> Any:
        return self._models.execute_kw(
            self.db, self.uid, self.password, model, method, list(args), kwargs
        )

    def search_read(
        self,
        model: str,
        domain: list | None = None,
        fields: list[str] | None = None,
        limit: int = 0,
        order: str | None = None,
    ) -> list[dict]:
        kwargs: dict[str, Any] = {}
        if limit:
            kwargs["limit"] = limit
        if fields:
            kwargs["fields"] = fields
        if order:
            kwargs["order"] = order
        return self.execute(model, "search_read", domain or [], **kwargs)

    def read_group(
        self,
        model: str,
        domain: list | None,
        fields: list[str],
        groupby: list[str],
        lazy: bool = False,
    ) -> list[dict]:
        """Server-side aggregation. With lazy=False and a date/datetime field in
        groupby (e.g. "date_order:day"), each result includes a "__range" entry
        giving exact {"from", "to"} bounds for the bucket — that's what we key
        off, since the display label under the field name itself is locale-
        formatted and not safe to parse.
        """
        return self.execute(
            model, "read_group", domain or [], fields, groupby, lazy=lazy
        )


@lru_cache(maxsize=1)
def get_client() -> OdooClient:
    return OdooClient(
        url=os.environ.get("ODOO_URL", "").rstrip("/"),
        db=os.environ.get("ODOO_DB", ""),
        username=os.environ.get("ODOO_USERNAME", ""),
        password=os.environ.get("ODOO_PASSWORD", ""),
    )
