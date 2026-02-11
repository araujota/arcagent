"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, Edit3, Eye, EyeOff } from "lucide-react";

interface GherkinReviewProps {
  gherkinPublic: string;
  gherkinHidden: string;
  onEdit?: (type: "public" | "hidden", content: string) => void;
  onApprove?: () => void;
  isEditable?: boolean;
}

export function GherkinReview({
  gherkinPublic,
  gherkinHidden,
  onEdit,
  onApprove,
  isEditable = true,
}: GherkinReviewProps) {
  const [editingPublic, setEditingPublic] = useState(false);
  const [editingHidden, setEditingHidden] = useState(false);
  const [publicContent, setPublicContent] = useState(gherkinPublic);
  const [hiddenContent, setHiddenContent] = useState(gherkinHidden);

  const handleSavePublic = () => {
    onEdit?.("public", publicContent);
    setEditingPublic(false);
  };

  const handleSaveHidden = () => {
    onEdit?.("hidden", hiddenContent);
    setEditingHidden(false);
  };

  const publicScenarioCount =
    (gherkinPublic.match(/Scenario:/g) || []).length +
    (gherkinPublic.match(/Scenario Outline:/g) || []).length;
  const hiddenScenarioCount =
    (gherkinHidden.match(/Scenario:/g) || []).length +
    (gherkinHidden.match(/Scenario Outline:/g) || []).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Generated Gherkin Tests</CardTitle>
          {onApprove && (
            <Button size="sm" onClick={onApprove} className="gap-1">
              <CheckCircle className="h-3 w-3" />
              Approve
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="public">
          <TabsList>
            <TabsTrigger value="public" className="gap-1">
              <Eye className="h-3 w-3" />
              Public ({publicScenarioCount})
            </TabsTrigger>
            <TabsTrigger value="hidden" className="gap-1">
              <EyeOff className="h-3 w-3" />
              Hidden ({hiddenScenarioCount})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="public" className="mt-3">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="secondary" className="text-xs">
                Visible to agents
              </Badge>
              {isEditable && !editingPublic && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingPublic(true)}
                  className="h-6 gap-1 text-xs"
                >
                  <Edit3 className="h-3 w-3" />
                  Edit
                </Button>
              )}
            </div>
            {editingPublic ? (
              <div className="space-y-2">
                <Textarea
                  value={publicContent}
                  onChange={(e) => setPublicContent(e.target.value)}
                  className="font-mono text-xs min-h-[300px]"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSavePublic}>
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPublicContent(gherkinPublic);
                      setEditingPublic(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <pre className="p-4 rounded-md bg-muted text-xs font-mono overflow-auto max-h-[400px] whitespace-pre-wrap">
                {gherkinPublic || "No public tests generated."}
              </pre>
            )}
          </TabsContent>

          <TabsContent value="hidden" className="mt-3">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className="text-xs">
                Hidden from agents
              </Badge>
              {isEditable && !editingHidden && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingHidden(true)}
                  className="h-6 gap-1 text-xs"
                >
                  <Edit3 className="h-3 w-3" />
                  Edit
                </Button>
              )}
            </div>
            {editingHidden ? (
              <div className="space-y-2">
                <Textarea
                  value={hiddenContent}
                  onChange={(e) => setHiddenContent(e.target.value)}
                  className="font-mono text-xs min-h-[300px]"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveHidden}>
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setHiddenContent(gherkinHidden);
                      setEditingHidden(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <pre className="p-4 rounded-md bg-muted text-xs font-mono overflow-auto max-h-[400px] whitespace-pre-wrap">
                {gherkinHidden || "No hidden tests generated."}
              </pre>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
